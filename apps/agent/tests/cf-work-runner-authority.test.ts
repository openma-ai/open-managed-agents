import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { createCfWorkRunnerAuthority } from "../../main/src/lib/cf-work-runner-authority";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";
beforeAll(async () => { await exports.default.fetch(new Request("http://localhost/health")); });
async function fixture() {
  const sql = new CfD1SqlClient(env.MAIN_DB); const suffix = crypto.randomUUID();
  const sessionId = "session_" + suffix, environmentId = "env_" + suffix, workId = "work_" + suffix;
  await seedSandboxGatewaySessionRows(sql, "default", { id: sessionId, environmentId, vaultIds: [], agent: { id: "business-agent", version: 9 }, archivedAt: null });
  const document = { id: sessionId, environmentId, agent: { id: "business-agent", version: 9, openma: { harness: "acp-sandbox", acp: { agent: { registry: "claude-acp@0.94.0" } } } } };
  await sql.prepare("UPDATE managed_sessions SET document = ? WHERE workspace_id = ? AND id = ?").bind(JSON.stringify(document), "default", sessionId).run();
  await sql.prepare("INSERT OR REPLACE INTO managed_environments (workspace_id,id,document,revision,created_at,updated_at,archived_at) VALUES ('default',?,?,1,?,?,NULL)").bind(environmentId, JSON.stringify({ id: environmentId, config: { type: "cloud" } }), Date.now(), Date.now()).run();
  const work = new SqlEnvironmentWorkStore(sql, { seal: async ({ plaintext }) => ({ ciphertext: plaintext }), open: async ({ ciphertext }) => ({ plaintext: ciphertext }) });
  const now = new Date().toISOString(); const token = "sk-ant-req-v1." + suffix;
  await work.insert({ workspaceId: "default", record: { work: { id: workId, environmentId, data: { id: sessionId, type: "session" }, acknowledgedAt: null, createdAt: now, latestHeartbeatAt: null, metadata: {}, startedAt: null, state: "queued", stopRequestedAt: null, stoppedAt: null }, secret: { sessionsToken: token }, claim: { generation: 1, claimedAt: now, workerId: "worker" }, heartbeatTtlSeconds: 90 } });
  const delivery = { workspaceId: "default", environmentId, sessionId, workId, apiBaseUrl: "https://control.test", workSecret: btoa(JSON.stringify({ sessions_token: token, api_base_url: "https://control.test", claim_generation: 1 })) };
  const authorize = createCfWorkRunnerAuthority({ sql, work, controlPlaneOrigin: "https://control.test" });
  return { sql, work, delivery, authorize };
}
it("reads pinned registry from real tenant D1 and permits reserved Work before runner ACK", async () => {
  const f = await fixture(); const result = await f.authorize(f.delivery);
  expect(result?.generation).toBe(1); expect(result?.harness).toEqual({ id: "claude-acp", version: "0.94.0" });
  expect(result?.session.agent.id).toBe("business-agent");
});
it("stopped claim refuses using the same row without fallback to supplied selection", async () => {
  const f = await fixture(); await f.sql.prepare("UPDATE managed_environment_work SET state='stopped' WHERE workspace_id='default' AND id=?").bind(f.delivery.workId).run();
  expect(await f.authorize({ ...f.delivery, selection: { harnessPlacement: "in_sandbox" } } as never)).toBeNull();
});
it("wrong Work secret and missing workspace fail closed", async () => {
  const f = await fixture(); expect(await f.authorize({ ...f.delivery, workSecret: btoa(JSON.stringify({ sessions_token: "sk-ant-req-v1.other", api_base_url: "https://control.test" })) })).toBeNull();
  expect(await f.authorize({ ...f.delivery, workspaceId: "" })).toBeNull();
});
it("does not guess registry release from Agent id/version when its pin is absent", async () => {
  const f = await fixture(); await f.sql.prepare("UPDATE managed_sessions SET document=? WHERE workspace_id='default' AND id=?").bind(JSON.stringify({ id:f.delivery.sessionId, environmentId:f.delivery.environmentId, agent:{id:"business-agent",version:9,openma:{harness:"acp-sandbox"}} }),f.delivery.sessionId).run();
  expect(await f.authorize(f.delivery)).toBeNull();
});

it("composes real D1 authority and token store through the real CF bootstrap wrapper", async () => {
  const f = await fixture();
  const { createCfSqlWorkRunnerDispatch } = await import("../../main/src/lib/cf-work-runner-authority");
  const { CloudflareSandbox, setCloudflareSandboxForTest } = await import("../src/runtime/sandbox");
  const { attemptSandboxTokens, issueSandboxToken, sandboxTokenSha256 } = await import("@open-managed-agents/sandbox-gateway");
  const { createSqlEnvironmentWorkSandboxTokenStore, environmentWorkSandboxTokenRef } = await import("@open-managed-agents/sandbox-gateway-sql");
  const calls: unknown[][] = []; let signs = 0;
  setCloudflareSandboxForTest({ async setOutboundHandler(_name: string, context: unknown) { calls.push(["egress", context]); }, async setOutboundByHost() {}, async restrictOutboundToHosts(hosts: string[]) { calls.push(["network", hosts]); }, async startProcess(command: string, options: unknown) { calls.push(["start", command, options]); return { id: "runner", pid: 10, async kill() {}, async getStatus() { return "running"; } }; } });
  try {
    const runtime = new CloudflareSandbox({ SANDBOX: {}, MAIN_MCP: {} } as never, f.delivery.sessionId);
    const dispatcher = await createCfSqlWorkRunnerDispatch({ sql: f.sql, work: f.work, controlPlaneOrigin: "https://control.test", command: "/opt/openma/bin/openma-acp-work-item", tokens: attemptSandboxTokens(), sandbox: async () => runtime });
    await dispatcher.dispatch({ ...f.delivery, signal: new AbortController().signal });
    const launched = calls.find(c => c[0] === "start")![2] as { env: Record<string, string>; environmentMode: string };
    const egress = calls.find(c => c[0] === "egress")![1] as { tokenSha256: string };
    expect(launched.environmentMode).toBe("replace");
    expect(launched.env.OPENMA_HARNESS_ID).toBe("claude-acp"); expect(launched.env.OPENMA_HARNESS_VERSION).toBe("0.94.0");
    expect(egress.tokenSha256).toBe(await sandboxTokenSha256(launched.env.OPENMA_SANDBOX_TOKEN));
    const row = await f.sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE workspace_id='default' AND id=?").bind(f.delivery.workId).first<{sandbox_token_hashes:string}>();
    const hashes = JSON.parse(row!.sandbox_token_hashes); expect(hashes).toHaveLength(1); expect(hashes[0].s).toBe("all");
    // No host ACK: the dispatched runner owns its existing admission barrier.
    const work = await f.sql.prepare("SELECT state FROM managed_environment_work WHERE workspace_id='default' AND id=?").bind(f.delivery.workId).first<{state:string}>(); expect(work?.state).toBe("queued");
  } finally { setCloudflareSandboxForTest(undefined); }
});

it("uses the shared trusted installed resolver with exact scope, pinnedSession and signal", async () => {
  const f = await fixture(); await f.sql.prepare("UPDATE managed_sessions SET document=? WHERE workspace_id='default' AND id=?").bind(JSON.stringify({id:f.delivery.sessionId,environmentId:f.delivery.environmentId,agent:{id:"not-harness",version:9,openma:{harness:"acp-sandbox"}}}), f.delivery.sessionId).run();
  const signal = new AbortController().signal; let seen: any;
  const authorize = createCfWorkRunnerAuthority({ sql:f.sql, work:f.work, controlPlaneOrigin:"https://control.test", installedHarnessResolver:{async resolve(input) { seen=input; return {id:"operator-installed",version:"2.3.4"}; }} });
  expect((await authorize(f.delivery, signal))?.harness).toEqual({id:"operator-installed",version:"2.3.4"});
  expect(seen.scope).toEqual({workspaceId:"default",environmentId:f.delivery.environmentId,sessionId:f.delivery.sessionId,workId:f.delivery.workId}); expect(seen.signal).toBe(signal); expect(seen.pinnedSession.agent.id).toBe("not-harness");
});
it("actual agent HTTP dispatch reaches trusted SQL authority then management bootstrap", async () => {
  const f = await fixture(); const { WebCryptoAesGcm } = await import("@open-managed-agents/integrations-adapters-cf");
  const { CloudflareSandbox, setCloudflareSandboxForTest } = await import("../src/runtime/sandbox");
  const secret = "entry-test-root-012345678901234567890";
  const crypto = new WebCryptoAesGcm(secret, "managed.environment-work.secret");
  const stored = await f.work.find(f.delivery); await f.sql.prepare("UPDATE managed_environment_work SET sealed_secret=? WHERE workspace_id='default' AND id=?").bind(await crypto.encrypt(JSON.stringify(stored!.secret)),f.delivery.workId).run();
  let starts=0;
  setCloudflareSandboxForTest({ async setOutboundHandler(){}, async setOutboundByHost(){}, async restrictOutboundToHosts(){}, async startProcess(){ starts++; return {id:"p",pid:1,async kill(){},async getStatus(){return "running";}}; } });
  try {
    const app = (await import("../src/index")).default;
    const response = await app.fetch(new Request("https://agent.test/__internal/work/dispatch", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(f.delivery)}), {...env,PLATFORM_ROOT_SECRET:secret,PUBLIC_BASE_URL:"https://control.test",MAIN_MCP:{},OPENMA_WORK_RUNNER_COMMAND:"/opt/openma/bin/openma-acp-work-item"} as never);
    expect(response.status).toBe(200); expect(starts).toBe(1);
  } finally { setCloudflareSandboxForTest(undefined); }
});

it("real Work HTTP ACK CAS admits one of two dispatched runners, heartbeats, and settles", async () => {
  const f = await fixture();
  const { EnvironmentWorkApplicationService } = await import("../../../packages/managed-agents-application/src/environment-work/application");
  const { buildEnvironmentWorkRoutes } = await import("../../../packages/managed-agents-api/src/routes/environment-work");
  const { createClaimedEnvironmentWorkRunner } = await import("@open-managed-agents/managed-runtime-host");
  const application = new EnvironmentWorkApplicationService({ workspaceId:"default", work:undefined, store:f.work, environments:{find:async()=>({id:f.delivery.environmentId,archivedAt:null})}, availability:{wait:async()=>{}}, credentials:{issue:async()=>{throw Error("unused");},bindToClaim:async({secret}:any)=>({secret})},clock:{now:()=>new Date()} } as never);
  const http = buildEnvironmentWorkRoutes(application);
  const operations: string[] = []; let starts=0, finish!:()=>void, entered!:()=>void;
  const gate=new Promise<void>(r=>finish=r), started=new Promise<void>(r=>entered=r);
  async function send(op:string, query="", body?:unknown) {
    const response=await http.request("/"+f.delivery.environmentId+"/work/"+f.delivery.workId+"/"+op+query,{method:"POST",...(body?{headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{})});
    operations.push(op+":"+response.status); if(!response.ok) throw Object.assign(Error("Work HTTP "+response.status),{status:response.status}); return response.json();
  }
  const runner=()=>createClaimedEnvironmentWorkRunner({client:{ack:()=>send("ack"),heartbeat:(_id:any,p:any)=>send("heartbeat","?expected_last_heartbeat="+encodeURIComponent(p.expected_last_heartbeat)),stop:()=>send("stop","",{force:true})} as never,scheduler:{sleep:async(_ms,signal)=>new Promise<void>((_r,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))}});
  const input={environmentId:f.delivery.environmentId,sessionId:f.delivery.sessionId,workId:f.delivery.workId,execute:async()=>{starts++; entered(); await gate;}};
  const first=runner().run(input); await started;
  await expect(runner().run(input)).rejects.toThrow(); expect(starts).toBe(1);
  finish(); await first;
  expect(operations).toContain("ack:200"); expect(operations).toContain("ack:409"); expect(operations).toContain("heartbeat:200"); expect(operations).toContain("stop:200");
  expect((await f.work.find(f.delivery))?.work.state).toBe("stopped");
});

it("expired active Work cannot bootstrap via Work control-route grace", async () => {
  const f=await fixture(); await f.sql.prepare("UPDATE managed_environment_work SET state='active', claim_at=? WHERE workspace_id='default' AND id=?").bind(Date.now()-1000000,f.delivery.workId).run();
  expect(await f.authorize(f.delivery)).toBeNull();
});
it("actual entry rejects missing scope and mismatched secret without provider launch", async () => {
  const f=await fixture(); const app=(await import("../src/index")).default; const {setCloudflareSandboxForTest}=await import("../src/runtime/sandbox"); let starts=0;
  setCloudflareSandboxForTest({async startProcess(){starts++;}});
  try {
    const configured={...env,PLATFORM_ROOT_SECRET:"entry-test-root-012345678901234567890",PUBLIC_BASE_URL:"https://control.test",OPENMA_WORK_RUNNER_COMMAND:"/opt/openma/bin/runner"};
    const post=(body:unknown)=>app.fetch(new Request("https://agent.test/__internal/work/dispatch",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),configured as never);
    expect((await post({...f.delivery,workspaceId:""})).status).toBe(400);
    expect((await post({...f.delivery,workSecret:"not-current"})).status).toBe(409); expect(starts).toBe(0);
  } finally {setCloudflareSandboxForTest(undefined);}
});

it.each(["sandbox", "egress", "network"])("cached holder cannot authorize launch after Work stops during %s", async boundary => {
  const f=await fixture(); const {createCfSqlWorkRunnerDispatch}=await import("../../main/src/lib/cf-work-runner-authority");
  const {CloudflareSandbox,setCloudflareSandboxForTest}=await import("../src/runtime/sandbox"); const {attemptSandboxTokens}=await import("@open-managed-agents/sandbox-gateway");
  let starts=0, deliveries=0, stop=false;
  const lose=async()=>{await f.sql.prepare("UPDATE managed_environment_work SET state='stopped' WHERE workspace_id='default' AND id=?").bind(f.delivery.workId).run();};
  setCloudflareSandboxForTest({async setOutboundHandler(){if(stop&&boundary==="egress")await lose();},async setOutboundByHost(){},async restrictOutboundToHosts(){if(stop&&boundary==="network")await lose();},async startProcess(){starts++;return{id:"p",pid:1,async kill(){},async getStatus(){return"running";}};}});
  try {
    const runtime=new CloudflareSandbox({SANDBOX:{},MAIN_MCP:{}} as never,f.delivery.sessionId);
    const dispatcher=await createCfSqlWorkRunnerDispatch({sql:f.sql,work:f.work,controlPlaneOrigin:"https://control.test",command:"/opt/openma/bin/runner",tokens:attemptSandboxTokens(),sandbox:async()=>{deliveries++;if(stop&&boundary==="sandbox")await lose();return runtime;}});
    await dispatcher.dispatch({...f.delivery,signal:new AbortController().signal}); expect(starts).toBe(1);
    stop=true; await expect(dispatcher.dispatch({...f.delivery,signal:new AbortController().signal})).rejects.toThrow(); expect(starts).toBe(1); expect(deliveries).toBe(2);
  } finally {setCloudflareSandboxForTest(undefined);}
});

it("existing dispatched EnvironmentWorker poll automatically reaches real CF entry and bootstrap without forwarding standing key", async () => {
  const f=await fixture(); const {WebCryptoAesGcm}=await import("@open-managed-agents/integrations-adapters-cf");
  const cipher=new WebCryptoAesGcm("auto-root-012345678901234567890123", "managed.environment-work.secret"); const stored=await f.work.find(f.delivery);
  await f.sql.prepare("UPDATE managed_environment_work SET sealed_secret=? WHERE workspace_id='default' AND id=?").bind(await cipher.encrypt(JSON.stringify(stored!.secret)),f.delivery.workId).run();
  const {setCloudflareSandboxForTest}=await import("../src/runtime/sandbox"); let starts=0,polls=0; let launched:any;
  setCloudflareSandboxForTest({async setOutboundHandler(){},async setOutboundByHost(){},async restrictOutboundToHosts(){},async startProcess(_c:any,o:any){starts++;launched=o.env;return{id:"p",pid:1,async kill(){},async getStatus(){return"running";}};}});
  try {
    const {createCfDispatchedEnvironmentWorker}=await import("../src/runtime/cf-environment-worker");
    const worker=createCfDispatchedEnvironmentWorker({...env,PLATFORM_ROOT_SECRET:"auto-root-012345678901234567890123",PUBLIC_BASE_URL:"https://control.test",MAIN_MCP:{},OPENMA_WORK_RUNNER_COMMAND:"/opt/openma/bin/runner"} as never,{environmentId:f.delivery.environmentId,workspaceId:"default",environmentKey:"standing-must-stay-host"},{baseURL:"https://control.test",beta:{webhooks:{unwrap:()=>({id:"event",type:"event",data:{type:"session.status_run_started",workspace_id:"default"}})}},withOptions:()=>({beta:{environments:{work:{poll:async()=>++polls===1?{id:f.delivery.workId,environment_id:f.delivery.environmentId,data:{type:"session",id:f.delivery.sessionId},secret:f.delivery.workSecret,metadata:{}}:null,stop:async()=>{throw Error("Host must not stop claimed Work");}}}}})} as never);
    const waits:Promise<unknown>[]=[]; expect(worker.handleWebhook({body:"signed",headers:{},waitUntil:p=>waits.push(p)}).type).toBe("triggered"); await Promise.all(waits);
    expect(starts).toBe(1); expect(polls).toBe(2); expect(launched.ANTHROPIC_WORK_SECRET).toBe(f.delivery.workSecret); expect(JSON.stringify(launched)).not.toContain("standing-must-stay-host");
  } finally {setCloudflareSandboxForTest(undefined);}
});

it("production Worker webhook rejects unsigned wakeups before poll or dispatch", async () => {
 const app=(await import("../src/index")).default;
 const response=await app.fetch(new Request("https://agent.test/__internal/work/webhook",{method:"POST",body:"{}"}),{...env,PUBLIC_BASE_URL:"https://control.test",OPENMA_WORK_ENVIRONMENT_ID:"env",OPENMA_WORK_WORKSPACE_ID:"default",OPENMA_WORK_ENVIRONMENT_KEY:"standing",OPENMA_WORK_WEBHOOK_KEY:"whsec_dGVzdC10ZXN0LXRlc3QtdGVzdA=="} as never,{waitUntil(){throw Error("Unsigned request must not schedule Work");}} as never);
 expect(response.status).toBe(403);
});

it.each(["valid", "latest", "duplicate", "relative-command", "invalid-argv", "unselected-invalid"]) ("actual HTTP entry validates complete installed inventory before mutation: %s", async mode => {
 const f=await fixture(); const {WebCryptoAesGcm}=await import("@open-managed-agents/integrations-adapters-cf"); const {setCloudflareSandboxForTest}=await import("../src/runtime/sandbox");
 await f.sql.prepare("UPDATE managed_sessions SET document=? WHERE workspace_id='default' AND id=?").bind(JSON.stringify({id:f.delivery.sessionId,environmentId:f.delivery.environmentId,agent:{id:"business-agent",version:9,openma:{harness:"acp-sandbox",acp:{agent:{command:"/opt/agents/fixed",args:["--acp"]}}}}}),f.delivery.sessionId).run();
 const secret="inventory-root-012345678901234567890"; const cipher=new WebCryptoAesGcm(secret,"managed.environment-work.secret"); const stored=await f.work.find(f.delivery); await f.sql.prepare("UPDATE managed_environment_work SET sealed_secret=? WHERE workspace_id='default' AND id=?").bind(await cipher.encrypt(JSON.stringify(stored!.secret)),f.delivery.workId).run();
 let launched:any; let mutations=0; setCloudflareSandboxForTest({async setOutboundHandler(){mutations++;},async setOutboundByHost(){mutations++;},async restrictOutboundToHosts(){mutations++;},async startProcess(_c:any,o:any){mutations++;launched=o.env;return{id:"p",pid:1,async kill(){},async getStatus(){return"running";}};}});
 try {
  const app=(await import("../src/index")).default;
  const item={id:"installed-release",version:"2.4.6",command:"/opt/agents/fixed",args:["--acp"]};
  const inventory=mode==="duplicate"?[item,{...item,command:"/opt/other"}]:mode==="unselected-invalid"?[item,{...item,id:"other",args:["bad\0arg"]}]:[{...item,...(mode==="latest"?{version:"latest"}:mode==="relative-command"?{command:"relative"}:mode==="invalid-argv"?{args:[1]}:{})}];
  const response=await app.fetch(new Request("https://agent.test/__internal/work/dispatch",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...f.delivery,selection:{harness:{id:"forged",version:"99"}}})}),{...env,PLATFORM_ROOT_SECRET:secret,PUBLIC_BASE_URL:"https://control.test",MAIN_MCP:{},OPENMA_WORK_RUNNER_COMMAND:"/opt/openma/bin/runner",OPENMA_ACP_HARNESSES:JSON.stringify(inventory)} as never);
  if(mode==="valid"){expect(response.status).toBe(200);expect(launched.OPENMA_HARNESS_ID).toBe("installed-release");expect(launched.OPENMA_HARNESS_VERSION).toBe("2.4.6");expect(JSON.parse(launched.OPENMA_ACP_HARNESSES)[0].command).toBe("/opt/agents/fixed");}
  else{expect(response.status).toBe(409);expect(mutations).toBe(0);expect(launched).toBeUndefined();}
 } finally {setCloudflareSandboxForTest(undefined);}
});

it("bootstrap failure rejects the drain with safe observable diagnostics and no ACK/stop", async () => {
 const {createCfDispatchedEnvironmentWorker}=await import("../src/runtime/cf-environment-worker");const {vi}=await import("vitest");const report=vi.spyOn(console,"error").mockImplementation(()=>{});let polls=0,stops=0;
 try {
  const worker=createCfDispatchedEnvironmentWorker({...env,PUBLIC_BASE_URL:"https://control.test"} as never,{environmentId:"env",workspaceId:"default",environmentKey:"standing-private"},{baseURL:"https://control.test",beta:{webhooks:{unwrap:()=>({id:"event",type:"event",data:{type:"session.status_run_started",workspace_id:"default"}})}},withOptions:()=>({beta:{environments:{work:{poll:async()=>{polls++;return{id:"work",environment_id:"env",data:{type:"session",id:"sess"},secret:"work-private",metadata:{}};},stop:async()=>{stops++;}}}}})} as never);
  await expect(worker.drain()).rejects.toThrow("CF EnvironmentWorker failed");expect(polls).toBe(1);expect(stops).toBe(0);expect(report).toHaveBeenCalled();expect(JSON.stringify(report.mock.calls)).not.toMatch(/standing-private|work-private/);
 } finally {report.mockRestore();}
});
it("signed webhook background poll failure stays rejected without leaking dependency error", async () => {
 const {createCfDispatchedEnvironmentWorker}=await import("../src/runtime/cf-environment-worker");const {vi}=await import("vitest");const report=vi.spyOn(console,"error").mockImplementation(()=>{});const waits:Promise<unknown>[]=[];
 try {
  const worker=createCfDispatchedEnvironmentWorker({...env,PUBLIC_BASE_URL:"https://control.test"} as never,{environmentId:"env",workspaceId:"default",environmentKey:"standing-private"},{baseURL:"https://control.test",beta:{webhooks:{unwrap:()=>({id:"event",type:"event",data:{type:"session.status_run_started",workspace_id:"default"}})}},withOptions:()=>({beta:{environments:{work:{poll:async()=>{throw Error("raw-private-credential");},stop:async()=>{throw Error("unexpected");}}}}})} as never);
  worker.handleWebhook({body:"verified-by-client",headers:{},waitUntil:p=>waits.push(p)});const settled=await Promise.allSettled(waits);expect(settled[0].status).toBe("rejected");expect(String((settled[0] as PromiseRejectedResult).reason)).not.toContain("private");expect(JSON.stringify(report.mock.calls)).not.toContain("private");
 } finally {report.mockRestore();}
});
