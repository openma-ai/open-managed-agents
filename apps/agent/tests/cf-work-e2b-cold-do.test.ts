import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { SessionDO } from "../src/runtime/session-do";
import { dispatchCfWorkRunnerRequest } from "../src/runtime/cf-work-runner-entry";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { createCfWorkRunnerAuthority } from "../../main/src/lib/cf-work-runner-authority";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";

// Actual SessionDO.fetch + SQL + PortsSessionSandbox + E2B Files adapter.
// Only E2B SDK remote operations/launcher are simulated, not cloud certified.
const provider=vi.hoisted(()=>({creates:0,starts:0,kills:0,renewals:0,failInstall:false,onInstall:undefined as undefined|(()=>Promise<void>),ops:[] as string[],files:new Map<string,string>(),slot:null as any,hold:undefined as undefined|{entered:()=>void;wait:Promise<void>;op?:string;skip?:number}}));
vi.mock("e2b",()=>{
 const sandbox={sandboxId:"physical",setTimeout:async()=>{provider.renewals++;},kill:async()=>{},updateNetwork:async()=>{},
 commands:{run:async(command:string)=>{
  const marker=command.match(/echo ([a-f0-9]+) > \/tmp\/\.oma-warm/);
  if(marker)provider.files.set("/tmp/.oma-warm",marker[1]);
  const probe=command.match(/if \[ -f '([^']+)' \]; then printf 1; else printf 0; fi/);
  if(probe)return {exitCode:0,stdout:provider.files.has(probe[1])?"1":"0",stderr:""};
  if(command.includes("id -u; id -g"))return {exitCode:0,stdout:"1000\n1000\n",stderr:""};
  if(command.includes("OMA_ACP_INSTALL_OK")){
   await provider.onInstall?.();
   return {exitCode:provider.failInstall?1:0,stdout:provider.failInstall?"":"OMA_ACP_LAUNCHER=/home/oma-worker/.oma/installed-agent/codex-acp/1.8.0/acp-launch.sh\nOMA_ACP_INSTALL_OK",stderr:""};
  }
  return {exitCode:0,stdout:command.includes("cat /tmp/.oma-warm")?(provider.files.get("/tmp/.oma-warm")??""):"",stderr:""};
 }},
 files:{read:async(path:string,options?:{format?:string})=>{
  if(path.endsWith("/ready"))return "oma-managed-v2";
  if(!path.endsWith(".response.json")){const content=provider.files.get(path);if(content===undefined)throw Object.assign(Error("missing file"),{name:"NotFoundError"});return options?.format==="bytes"?new TextEncoder().encode(content):content;}
  const req=JSON.parse(provider.files.get(path.replace(/\.response.json$/,".json"))!);
  if(req.op===(provider.hold?.op??"start")&&provider.hold){const hold=provider.hold;if((hold.skip??0)>0)hold.skip!--;else{provider.hold=undefined;hold.entered();await hold.wait;}}
  return provider.files.get(path);
 },write:async(path:string,content:string|Uint8Array)=>{
  provider.files.set(path,typeof content==="string"?content:new TextDecoder().decode(content));if(!path.endsWith(".go"))return;
  const req=JSON.parse(provider.files.get(path.replace(/\.go$/,".json"))!);provider.ops.push(req.op);
  let result:any={ok:true};
  if(req.op==="start"){
   if(provider.slot?.status==="running")result={ok:false,error:"management worker busy"};
   else{provider.starts++;provider.slot={id:req.id,epoch:"trusted-epoch",pid:41,identity:req.identity,status:"running"};result={ok:true,id:req.id,epoch:"trusted-epoch",pid:41};}
  }else if(req.op==="inspect-slot")result={ok:true,locator:provider.slot};
  else{if(req.target!==provider.slot.id||req.epoch!==provider.slot.epoch||JSON.stringify(req.identity)!==JSON.stringify(provider.slot.identity))throw Error("exact locator mismatch");
   if(req.op==="kill"){provider.kills++;provider.slot.status="exited";}
   result={ok:true,status:provider.slot.status};
  }
  provider.files.set(path.replace(/\.go$/,".response.json"),JSON.stringify(result));
 }},};
 return {Sandbox:{create:async()=>{provider.creates++;return sandbox;},connect:async()=>sandbox,kill:async()=>true}};
});
beforeAll(async()=>{await exports.default.fetch(new Request("http://localhost/health"));});
async function fixture() {
  const sql = new CfD1SqlClient((env as typeof env & { MAIN_DB: D1Database }).MAIN_DB), suffix = crypto.randomUUID();
  const delivery = { workspaceId: "default", environmentId: "env_"+suffix, sessionId: "sess_"+suffix, workId: "new_"+suffix, apiBaseUrl: "https://control.test", workSecret: "" };
  await seedSandboxGatewaySessionRows(sql, "default", {id:delivery.sessionId,environmentId:delivery.environmentId,vaultIds:[],agent:{id:"agent",version:1},archivedAt:null});
  await sql.prepare("UPDATE managed_sessions SET document=? WHERE workspace_id='default' AND id=?").bind(JSON.stringify({id:delivery.sessionId,environmentId:delivery.environmentId,resources:[],archivedAt:null,agent:{id:"agent",version:1,openma:{harness:"acp-sandbox",acp:{agent:{registry:"codex-acp@1.8.0"}}}}}),delivery.sessionId).run();
  await sql.prepare("INSERT OR REPLACE INTO managed_environments (workspace_id,id,document,revision,created_at,updated_at,archived_at) VALUES ('default',?,?,1,?,?,NULL)").bind(delivery.environmentId,JSON.stringify({id:delivery.environmentId,config:{type:"cloud"}}),Date.now(),Date.now()).run();
  const work = new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:plaintext}),open:async({ciphertext})=>({plaintext:ciphertext})});
  async function insert(id:string,generation:number) {
    const now=new Date().toISOString(),token="sk-ant-req-v1."+crypto.randomUUID();
    await work.insert({workspaceId:"default",record:{work:{id,environmentId:delivery.environmentId,data:{type:"session",id:delivery.sessionId},state:"active",createdAt:now,metadata:{},acknowledgedAt:now,latestHeartbeatAt:now,startedAt:now,stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:token},claim:{generation,claimedAt:now,workerId:"worker"},heartbeatTtlSeconds:90}});
    return token;
  }
  const token=await insert(delivery.workId,2); delivery.workSecret=btoa(JSON.stringify({sessions_token:token,api_base_url:delivery.apiBaseUrl,claim_generation:2}));
  const authorize=createCfWorkRunnerAuthority({sql,work,controlPlaneOrigin:delivery.apiBaseUrl});
  const identity={workspaceId:"default",sessionId:delivery.sessionId,workId:delivery.workId,attemptId:"environment-work-claim:2"};
  return {sql,work,delivery,identity,authorize,insert};
}
async function cold(f:Awaited<ReturnType<typeof fixture>>) {
 const root="test-platform-root-secret-padded-to-thirtytwo";
 const stored=await f.work.find(f.delivery),cipher=new WebCryptoAesGcm(root,"managed.environment-work.secret");
 await f.sql.prepare("UPDATE managed_environment_work SET sealed_secret=? WHERE workspace_id='default' AND id=?").bind(await cipher.encrypt(JSON.stringify(stored!.secret)),f.delivery.workId).run();
 const configured={...env,R2_ACCESS_KEY_ID:undefined,R2_SECRET_ACCESS_KEY:undefined,R2_FILES_ACCESS_KEY_ID:undefined,R2_FILES_SECRET_ACCESS_KEY:undefined,PLATFORM_ROOT_SECRET:root,PUBLIC_BASE_URL:f.delivery.apiBaseUrl,SANDBOX_ADAPTER:"e2b",E2B_API_KEY:"private",E2B_TEMPLATE:"trusted",E2B_MAX_LIFETIME_MS:"3600000",MAIN_MCP:undefined};
 const stub=env.SESSION_DO!.get(env.SESSION_DO!.idFromName(JSON.stringify(["default",f.delivery.sessionId])));
 provider.creates=0;provider.starts=0;provider.kills=0;provider.ops=[];provider.files.clear();provider.slot=null;provider.hold=undefined;
 return {stub,configured};
}
function request(delivery:unknown,signal?:AbortSignal){return new Request("https://internal/__internal/work/dispatch",{method:"POST",body:JSON.stringify(delivery),signal});}
it("fully configured cold SessionDO.fetch succeeds without /init and persists the original E2B record",async()=>{
 const f=await fixture(),c=await cold(f);
 const namespace={idFromName:(name:string)=>env.SESSION_DO!.idFromName(name),get:(id:DurableObjectId)=>({async fetch(inbound:Request){
  expect(id.toString()).toBe(c.stub.id.toString());const body=await inbound.text();
  const result=await runInDurableObject(c.stub,async(_instance,state)=>{
   expect(state.storage.kv.get("e2b_sandbox_state")).toBeUndefined();
   const instance=new SessionDO(state,c.configured as never);
   const response=await instance.fetch(new Request("https://internal/__internal/work/dispatch",{method:"POST",body}));
   expect(state.storage.kv.get("e2b_sandbox_state")).toMatchObject({phase:"running",handle:{provider:"e2b",runtimeId:"physical"}});
   return {status:response.status,body:await response.text()};
  });return new Response(result.body,{status:result.status});
 }})};
 const response=await dispatchCfWorkRunnerRequest(request(f.delivery),{...c.configured,SESSION_DO:namespace} as never);
 expect(response.status).toBe(200);
 expect(provider.starts).toBe(1);expect(provider.kills).toBe(0);
});
it("same cold DO concurrent same Work fails closed on resource CAS without duplicate physical workers",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);
  const responses=await Promise.all([instance.fetch(request(f.delivery)),instance.fetch(request(f.delivery))]);
  expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
  expect((await instance.fetch(request(f.delivery))).status).toBe(200);
 });
 expect(provider.creates).toBe(1);expect(provider.starts).toBe(1);expect(provider.kills).toBe(0);
});
it("same DO concurrent different current Works cannot retire the other's still-current exact slot",async()=>{
 const f=await fixture(),c=await cold(f);const nextId="other_"+crypto.randomUUID(),token=await f.insert(nextId,1);
 const next={...f.delivery,workId:nextId,workSecret:btoa(JSON.stringify({sessions_token:token,api_base_url:f.delivery.apiBaseUrl,claim_generation:1}))};
 const stored=await f.work.find(next),cipher=new WebCryptoAesGcm(c.configured.PLATFORM_ROOT_SECRET,"managed.environment-work.secret");
 await f.sql.prepare("UPDATE managed_environment_work SET sealed_secret=? WHERE workspace_id='default' AND id=?").bind(await cipher.encrypt(JSON.stringify(stored!.secret)),nextId).run();
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);
  const responses=await Promise.all([instance.fetch(request(f.delivery)),instance.fetch(request(next))]);
  expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
 });
 expect(provider.creates).toBe(1);expect(provider.starts).toBe(1);expect(provider.kills).toBe(0);
});
it("hanging Files response remains unknown until acknowledgement; aborted duplicate never kills the existing current worker",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);
  expect((await instance.fetch(request(f.delivery))).status).toBe(200);
  let entered!:()=>void,release!:()=>void;
  const atRead=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
  provider.hold={entered,wait};const ac=new AbortController();let settled=false;
  const duplicate=instance.fetch(request(f.delivery,ac.signal)).then(response=>{settled=true;return response;});
  await atRead;ac.abort(Error("cancel duplicate while Files pending"));
  await Promise.resolve();expect(settled).toBe(false);expect(provider.kills).toBe(0);expect(provider.starts).toBe(1);
  release();expect((await duplicate).status).toBe(409);expect(provider.kills).toBe(0);
 });
});

it.each([false,true])("real Files restored final status cancellation preserves current worker and kills truly lost claim (lost=%s)",async lost=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);expect((await instance.fetch(request(f.delivery))).status).toBe(200);
  let entered!:()=>void,release!:()=>void;const atRead=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
  provider.hold={entered,wait,op:"status",skip:1};const ac=new AbortController();
  const pending=instance.fetch(request(f.delivery,ac.signal));await atRead;
  if(lost)await f.sql.prepare("UPDATE managed_environment_work SET state='stopped' WHERE workspace_id='default' AND id=?").bind(f.delivery.workId).run();
  ac.abort(Error("cancel at final restored Files status"));expect(provider.kills).toBe(0);release();
  expect((await pending).status).toBe(409);expect(provider.kills).toBe(lost?1:0);expect(provider.starts).toBe(1);
 });
});
it("a fresh launch with hanging Files acknowledgement is not retried; late abort cleans only its own exact handle",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);
  let entered!:()=>void,release!:()=>void;const atRead=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
  provider.hold={entered,wait};const ac=new AbortController();let settled=false;
  const pending=instance.fetch(request(f.delivery,ac.signal)).then(r=>{settled=true;return r;});await atRead;
  ac.abort(Error("abort fresh pending Files"));await Promise.resolve();expect(settled).toBe(false);expect(provider.starts).toBe(1);expect(provider.kills).toBe(0);
  release();expect((await pending).status).toBe(409);expect(provider.kills).toBe(1);expect(provider.starts).toBe(1);
 });
});

it("real cold DO/native Files handoff replaces a stopped claim:null worker using the retained generation",async()=>{
 const f=await fixture(),c=await cold(f),nextId="replacement_"+crypto.randomUUID(),token=await f.insert(nextId,1);
 const next={...f.delivery,workId:nextId,workSecret:btoa(JSON.stringify({sessions_token:token,api_base_url:f.delivery.apiBaseUrl,claim_generation:1}))};
 const cipher=new WebCryptoAesGcm(c.configured.PLATFORM_ROOT_SECRET,"managed.environment-work.secret"),stored=await f.work.find(next);
 await f.sql.prepare("UPDATE managed_environment_work SET sealed_secret=? WHERE workspace_id='default' AND id=?").bind(await cipher.encrypt(JSON.stringify(stored!.secret)),nextId).run();
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);expect((await instance.fetch(request(f.delivery))).status).toBe(200);
  await f.sql.prepare("UPDATE managed_environment_work SET state='stopped' WHERE workspace_id='default' AND id=?").bind(f.delivery.workId).run();
  const work=new SqlEnvironmentWorkStore(f.sql,{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})});
  expect((await work.find(f.delivery))?.claim).toBeNull();
  expect((await instance.fetch(request(next))).status).toBe(200);
 });
 expect(provider.starts).toBe(2);expect(provider.kills).toBe(1);expect(provider.slot.identity.workId).toBe(nextId);
});


it("dispatch registers the real native E2B lease with the owner, including leased stopping finalization", async () => {
 const {CfE2BWorkLease}=await import("../src/runtime/cf-work-provider-lease");
 const f=await fixture(),c=await cold(f),lease=new CfE2BWorkLease();provider.renewals=0;
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const response=await dispatchCfWorkRunnerRequest(request(f.delivery),c.configured as never,{storage:state.storage,id:state.id.toString(),hasSessionExecution:false,workLease:lease});
  expect(response.status).toBe(200);expect(provider.renewals).toBe(1);
  await f.sql.prepare("UPDATE managed_environment_work SET state='stopping' WHERE id=?").bind(f.delivery.workId).run();
  await lease.maintain();expect(provider.renewals).toBe(2);
  await f.sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes='[]' WHERE id=?").bind(f.delivery.workId).run();
  await lease.maintain();expect(provider.renewals).toBe(2);expect(provider.kills).toBe(1);expect(lease.active).toBe(false);
 });
});

it.each(["failed-install", "claim-expires-during-install"] as const)("%s never launches an E2B Work process", async mode => {
 const f=await fixture(),c=await cold(f);
 provider.failInstall=mode==="failed-install";
 provider.onInstall=mode==="claim-expires-during-install"?async()=>{await f.sql.prepare("UPDATE managed_environment_work SET claim_at=? WHERE id=?").bind(Date.now()-90001,f.delivery.workId).run();}:undefined;
 try {
  await runInDurableObject(c.stub,async(_instance,state)=>{
   const response=await dispatchCfWorkRunnerRequest(request(f.delivery),c.configured as never,{storage:state.storage,id:state.id.toString(),hasSessionExecution:false});
   expect(response.status).toBe(409);expect(provider.starts).toBe(0);
  });
 } finally {provider.failInstall=false;provider.onInstall=undefined;}
});

it.each([undefined,"read_only"] as const)("cold Work bootstraps canonical Memory at the published path and physical generation (access=%s)",async access=>{
 const f=await fixture(),c=await cold(f),storeId="store_"+crypto.randomUUID(),now=new Date().toISOString();
 Object.assign(c.configured,{R2_ACCESS_KEY_ID:undefined,R2_SECRET_ACCESS_KEY:undefined,R2_FILES_ACCESS_KEY_ID:undefined,R2_FILES_SECRET_ACCESS_KEY:undefined});
 await f.sql.prepare("INSERT INTO managed_memory_stores VALUES ('default',?,?,1,?,?,NULL)").bind(storeId,JSON.stringify({id:storeId,name:"Project Notes",description:null,metadata:{},createdAt:now,updatedAt:now,archivedAt:null}),Date.now(),Date.now()).run();
 await f.sql.prepare("UPDATE managed_sessions SET document=json_set(document,'$.resources',json(?),'$.archivedAt',NULL) WHERE id=?").bind(JSON.stringify([{type:"memory_store",memoryStoreId:storeId,name:"Project Notes",mountPath:"/mnt/memory/project-notes",access}]),f.delivery.sessionId).run();
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);
  const response=await instance.fetch(request(f.delivery));
  expect(response.status,await response.clone().text()).toBe(200);
  const record=state.storage.kv.get("e2b_sandbox_state") as {stores:Array<{storeId:string;storeName:string;readOnly:boolean}>};
  expect(record.stores).toHaveLength(1);
  expect(record.stores[0]).toMatchObject({storeName:"project-notes",readOnly:access==="read_only"});
  if(access==="read_only") {
   expect(record.stores[0].storeId).toMatch(new RegExp(`^\\.openma-managed-memory-snapshots/default/${storeId}/[a-f0-9]{64}$`));
  } else {
  expect(record.stores[0].storeId).toMatch(new RegExp(`^\\.openma-managed-memory-workspaces/default/${f.delivery.sessionId}/[^/]+/${storeId}/data$`));
  expect(await env.MEMORY_BUCKET!.get(record.stores[0].storeId.replace(/data$/,"manifest.json"))).not.toBeNull();
  }
  // Reattachment retains the same physical-generation projection.
  expect((await instance.fetch(request(f.delivery))).status).toBe(200);
  expect((state.storage.kv.get("e2b_sandbox_state") as typeof record).stores).toEqual(record.stores);
  expect(provider.creates).toBe(1);
 });
});
