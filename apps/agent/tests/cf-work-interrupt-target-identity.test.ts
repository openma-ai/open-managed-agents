import { env, exports } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";
import { beforeAll, it, expect, vi } from "vitest";
import main from "../../main/src/index";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";

beforeAll(async () => { await exports.default.fetch(new Request("http://localhost/health")); });

async function setup() {
  const configured = { ...env, API_KEY: "test-key", PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo" };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const transport: typeof fetch = (raw, init) => main.fetch(new Request(raw, init), configured as never, ctx as never);
  async function post(path: string, body: unknown) {
    const response = await transport("https://control.test" + path, {
      method: "POST", headers: { "x-api-key": "test-key", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(response.status).toBeLessThan(400);
    return response.json() as Promise<any>;
  }
  const agent = await post("/v1/agents", {
    name: "cas-" + crypto.randomUUID(), model: "unused", tools: [],
    _oma: { harness: "acp-sandbox", acp: { agent: { command: "/usr/local/bin/openma-pi-acp" } } },
  });
  const environment = await post("/v1/environments", { name: "cas-" + crypto.randomUUID(), config: { type: "cloud" } });
  const session = await post("/v1/sessions", { agent: agent.id, environment_id: environment.id });
  const standing = await post("/v1/oma/api_keys", { name: "cas-worker", environment_id: environment.id });
  const client = new Anthropic({ apiKey: null, authToken: standing.key, baseURL: "https://control.test", maxRetries: 0, fetch: transport });
  const work = (await client.beta.environments.work.poll(environment.id, {}))!;
  const secret = JSON.parse(atob(work.secret!));
  const owner = client.withOptions({ apiKey: null, authToken: secret.sessions_token });
  return { post, transport, environment, session, client, work, owner };
}

async function sendInterrupt(f: Awaited<ReturnType<typeof setup>>, key = "interrupt-once") {
  return f.transport("https://control.test/v1/sessions/" + f.session.id + "/events", {
    method: "POST", headers: { "x-api-key": "test-key", "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ events: [{ type: "user.interrupt" }] }),
  });
}
async function state(f: Awaited<ReturnType<typeof setup>>) {
  return (await env.MAIN_DB.prepare("SELECT state FROM managed_environment_work WHERE id=?").bind(f.work.id).first<{state:string}>())!.state;
}
async function history(f: Awaited<ReturnType<typeof setup>>) {
  const response = await f.transport("https://control.test/v1/sessions/" + f.session.id + "/events", { headers: { "x-api-key": "test-key" } });
  return (await response.json() as any).data;
}


async function laterWork(f,offset=0,markProcessed=false){const stamp=await env.MAIN_DB.prepare("SELECT id,processed_at,document FROM managed_session_events WHERE session_id=? AND type='user.interrupt'").bind(f.session.id).first<any>();const accepted=Number(stamp!.processed_at),later=accepted+offset,id='work_'+crypto.randomUUID();if(markProcessed){const {SqlSessionEventStore}=await import('../../../packages/session-event-store-sql/src/index');const {CfD1SqlClient}=await import('@open-managed-agents/sql-client/adapters/cf-d1');await new SqlSessionEventStore(new CfD1SqlClient(env.MAIN_DB)).markProcessed({workspaceId:'default',sessionId:f.session.id,eventIds:[stamp.id],processedAt:new Date(accepted+10000).toISOString()});}await env.MAIN_DB.prepare("INSERT INTO managed_environment_work (workspace_id,environment_id,id,session_id,document,sealed_secret,claim_at,claim_worker_id,claim_generation,heartbeat_ttl_seconds,revision,state,created_at) SELECT workspace_id,environment_id,?,session_id,json_set(document,'$.id',?,'$.state','queued','$.stopRequestedAt',NULL,'$.stoppedAt',NULL,'$.createdAt',?),sealed_secret,NULL,NULL,0,90,1,'queued',? FROM managed_environment_work WHERE id=?").bind(id,id,new Date(later).toISOString(),later,f.work.id).run();return{id,accepted,later};}
it.each(['same-millisecond','later','processed-later'])('replayed old interrupt preserves sequentially later Work: %s',async mode=>{const f=await setup();expect((await sendInterrupt(f)).status).toBe(200);const newer=await laterWork(f,mode==='same-millisecond'?0:1,mode==='processed-later');const before=await history(f);expect((await sendInterrupt(f)).status).toBe(200);const row=await env.MAIN_DB.prepare('SELECT state,revision FROM managed_environment_work WHERE id=?').bind(newer.id).first<any>();console.log('REVIEW_CUTOFF',JSON.stringify({mode,...newer,...row}));expect(await history(f)).toEqual(before);expect(row).toEqual({state:'queued',revision:1});});
it('persistent contention is exactly three attempts per request then same-key recovers',async()=>{const f=await setup();await f.owner.beta.environments.work.ack(f.work.id,{environment_id:f.environment.id});const original=SqlEnvironmentWorkStore.prototype.replace;let collisions=0;const spy=vi.spyOn(SqlEnvironmentWorkStore.prototype,'replace').mockImplementation(async function(input){if(input.workId===f.work.id&&input.next.work.stopRequestedAt){collisions++;await f.owner.beta.environments.work.heartbeat(f.work.id,{environment_id:f.environment.id});}return original.call(this,input);});try{expect((await sendInterrupt(f)).status).toBe(500);expect(collisions).toBe(3);expect((await sendInterrupt(f)).status).toBe(500);expect(collisions).toBe(6);const accepted=await history(f);spy.mockRestore();expect((await sendInterrupt(f)).status).toBe(200);expect(await state(f)).toBe('stopping');expect(await history(f)).toEqual(accepted);await f.owner.beta.environments.work.stop(f.work.id,{environment_id:f.environment.id,force:true});expect((await sendInterrupt(f)).status).toBe(200);expect(await state(f)).toBe('stopped');}finally{spy.mockRestore();}});
it('CAS re-read stays on original Work when it settles and replacement appears',async()=>{const f=await setup();const original=SqlEnvironmentWorkStore.prototype.replace;let changed=false,newId;const spy=vi.spyOn(SqlEnvironmentWorkStore.prototype,'replace').mockImplementation(async function(input){if(!changed&&input.workId===f.work.id&&input.next.work.stopRequestedAt){changed=true;await env.MAIN_DB.prepare("UPDATE managed_environment_work SET state='stopped',revision=revision+1,document=json_set(document,'$.state','stopped') WHERE id=?").bind(f.work.id).run();newId=(await laterWork(f,1)).id;}return original.call(this,input);});try{expect((await sendInterrupt(f)).status).toBe(200);expect(changed).toBe(true);expect((await env.MAIN_DB.prepare('SELECT state FROM managed_environment_work WHERE id=?').bind(newId).first<any>()).state).toBe('queued');}finally{spy.mockRestore();}});
it('mixed message/tool/interrupt replay only reconciles stop and preserves canonical events',async()=>{const f=await setup();const payload={events:[{type:'user.message',content:[{type:'text',text:'mixed'}]},{type:'user.tool_result',tool_use_id:'tool-1',content:[{type:'text',text:'result'}]},{type:'user.interrupt'}]};const send=body=>f.transport('https://control.test/v1/sessions/'+f.session.id+'/events',{method:'POST',headers:{'x-api-key':'test-key','content-type':'application/json','Idempotency-Key':'mixed'},body:JSON.stringify(body)});const first=await send(payload);expect(first.status,await first.clone().text()).toBe(200);const firstBody=await first.json(),before=await history(f);const retry=await send(payload);expect(retry.status).toBe(200);expect(await retry.json()).toEqual(firstBody);expect(await history(f)).toEqual(before);expect((await send({events:payload.events.slice(0,2)})).status).toBe(409);expect(await state(f)).toBe('stopped');});
