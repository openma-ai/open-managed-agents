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
const provider=vi.hoisted(()=>({creates:0,starts:0,kills:0,renewals:0,failRenew:false,reads:0,connects:0,state:"running",autoResume:false,readFailure:false,renewGate:undefined as Promise<void>|undefined,ops:[] as string[],files:new Map<string,string>(),slot:null as any,processes:new Map<string,any>(),hold:undefined as undefined|{entered:()=>void;wait:Promise<void>;op?:string;skip?:number}}));
vi.mock("e2b",()=>{
 const sandbox={sandboxId:"physical",setTimeout:async()=>{provider.renewals++;if(provider.failRenew)throw Error("provider unavailable");if(provider.renewGate)await provider.renewGate;},kill:async()=>{},updateNetwork:async()=>{},
 commands:{run:async(command:string)=>({exitCode:0,stdout:command.includes("OMA_ACP_INSTALL_OK")?"OMA_ACP_LAUNCHER=/home/oma-worker/.oma/installed-agent/codex-acp/1.8.0/acp-launch.sh\nOMA_ACP_INSTALL_OK":command.includes("cat /tmp/.oma-warm")?"generation":"",stderr:""})},
 files:{read:async(path:string)=>{
  if(path.endsWith("/ready"))return "oma-managed-v2";
  const req=JSON.parse(provider.files.get(path.replace(/\.response.json$/,".json"))!);
  if(req.op===(provider.hold?.op??"start")&&provider.hold){const hold=provider.hold;if((hold.skip??0)>0)hold.skip!--;else{provider.hold=undefined;hold.entered();await hold.wait;}}
  return provider.files.get(path);
 },write:async(path:string,content:string)=>{
  provider.files.set(path,content);if(!path.endsWith(".go"))return;
  const req=JSON.parse(provider.files.get(path.replace(/\.go$/,".json"))!);provider.ops.push(req.op);
  let result:any={ok:true};
  if(req.op==="start"){
   if(provider.slot?.status==="running")result={ok:false,error:"management worker busy"};
   else{provider.starts++;provider.slot={sandboxId:"physical",holderHash:Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(req.spec.env.OPENMA_SANDBOX_TOKEN.slice(8,51))))).map(n=>n.toString(16).padStart(2,"0")).join(""),id:req.id,epoch:"trusted-epoch",pid:41,identity:req.identity,status:"running"};provider.processes.set(req.id,provider.slot);result={ok:true,id:req.id,epoch:"trusted-epoch",pid:41};}
  }else if(req.op==="inspect-slot")result={ok:true,locator:provider.slot};
  else{const target=provider.processes.get(req.target);if(!target||(req.holderHash!==undefined&&req.holderHash!==target.holderHash)||(req.sandboxId!==undefined&&req.sandboxId!==target.sandboxId)||req.epoch!==target.epoch||JSON.stringify(req.identity)!==JSON.stringify(target.identity))throw Error("exact locator mismatch");
   if(req.op==="kill"){provider.kills++;target.status="exited";}
   result={ok:true,status:target.status};
  }
  provider.files.set(path.replace(/\.go$/,".response.json"),JSON.stringify(result));
 }},};
 return {
  ConnectionConfig: class { constructor(public options: unknown) {} },
  ApiClient: class { api={GET:async(path:string,opts:any)=>{
   expect(path).toBe("/sandboxes/{sandboxID}");expect(opts.params.path.sandboxID).toBe("physical");provider.reads++;
   if(provider.readFailure)throw Error("provider read unavailable");
   return {data:{sandboxID:"physical",state:provider.state,lifecycle:{autoResume:provider.autoResume},envdVersion:"0.3.0",envdAccessToken:"remote-envd-token",domain:"test"}};
  }}; },
  Sandbox: class {
   constructor(opts:any){expect(opts.sandboxId).toBe("physical");expect(opts.envdAccessToken).toBe("remote-envd-token");return sandbox;}
   static async create(_template:string,opts:any){provider.creates++;provider.autoResume=opts.lifecycle.autoResume;return sandbox;}
   static async connect(){provider.connects++;return sandbox;}
   static async kill(){throw Error("must not destroy sandbox");}
  }
 };
});
beforeAll(async()=>{await exports.default.fetch(new Request("http://localhost/health"));});
async function fixture() {
  const sql = new CfD1SqlClient((env as typeof env & { MAIN_DB: D1Database }).MAIN_DB), suffix = crypto.randomUUID();
  const delivery = { workspaceId: "default", environmentId: "env_"+suffix, sessionId: "sess_"+suffix, workId: "new_"+suffix, apiBaseUrl: "https://control.test", workSecret: "" };
  await seedSandboxGatewaySessionRows(sql, "default", {id:delivery.sessionId,environmentId:delivery.environmentId,vaultIds:[],agent:{id:"agent",version:1},archivedAt:null});
  await sql.prepare("UPDATE managed_sessions SET document=? WHERE workspace_id='default' AND id=?").bind(JSON.stringify({id:delivery.sessionId,environmentId:delivery.environmentId,agent:{id:"agent",version:1,openma:{harness:"acp-sandbox",acp:{agent:{registry:"codex-acp@1.8.0"}}}}}),delivery.sessionId).run();
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
 const configured={...env,PLATFORM_ROOT_SECRET:root,PUBLIC_BASE_URL:f.delivery.apiBaseUrl,SANDBOX_ADAPTER:"e2b",E2B_API_KEY:"private",E2B_TEMPLATE:"trusted",E2B_MAX_LIFETIME_MS:"3600000",MAIN_MCP:undefined};
 const stub=env.SESSION_DO!.get(env.SESSION_DO!.idFromName(JSON.stringify(["default",f.delivery.sessionId])));
 provider.reads=0;provider.connects=0;provider.state="running";provider.autoResume=false;provider.readFailure=false;provider.renewals=0;provider.failRenew=false;provider.renewGate=undefined;provider.creates=0;provider.starts=0;provider.kills=0;provider.ops=[];provider.files.clear();provider.slot=null;provider.processes.clear();provider.hold=undefined;
 return {stub,configured};
}
function request(delivery:unknown,signal?:AbortSignal){return new Request("https://internal/__internal/work/dispatch",{method:"POST",body:JSON.stringify(delivery),signal});}

// Removing SessionDO's lease owner or its durable schedule breaks these tests.
it("SessionDO dispatch arms durable maintenance and alarm renews stopping finalization", async () => {
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);
  expect((await instance.fetch(request(f.delivery))).status).toBe(200);
  expect(provider.renewals).toBe(0);
  expect(await state.storage.getAlarm()).not.toBeNull();
  await f.sql.prepare("UPDATE managed_environment_work SET state='stopping' WHERE id=?").bind(f.delivery.workId).run();
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");
  await instance.alarm();
  expect(provider.renewals).toBe(1);expect(provider.kills).toBe(0);expect(provider.starts).toBe(1);
  expect(await state.storage.getAlarm()).not.toBeNull();
 });
});
it("provider failure is not loss, retains a durable retry and does not consume other schedules", async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);
  expect((await instance.fetch(request(f.delivery))).status).toBe(200);
  const other=await instance.schedule(3600,"recoverEventQueue",{});
  provider.failRenew=true;
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");
  await instance.alarm();
  expect(provider.renewals).toBe(1);expect(provider.kills).toBe(0);
  expect(instance.getSchedule(other.id)).toBeDefined();
  expect(instance.getSchedules().some(s=>s.callback==='maintainCfWorkLease')).toBe(true);
  expect(await state.storage.getAlarm()).not.toBeNull();
  provider.failRenew=false;
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");
  await instance.alarm();expect(provider.renewals).toBe(2);
 });
});
it("cold restart fails closed on the missing process-holder binding, retaining a retry without re-dispatch",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const first=new SessionDO(state,c.configured as never);
  expect((await first.fetch(request(f.delivery))).status).toBe(200);
  delete provider.slot.holderHash;
  const holders=await f.sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE id=?").bind(f.delivery.workId).first();
  await f.sql.prepare("UPDATE managed_environment_work SET state='stopping' WHERE id=?").bind(f.delivery.workId).run();
  const fresh=new SessionDO(state,c.configured as never);
  const errors=vi.spyOn(console,"error").mockImplementation(()=>{});
  try {
   state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");
   await fresh.alarm();
   expect(errors.mock.calls.flat().map(String).join(" ")).toContain("process-bound holder hash");
   expect(provider.renewals).toBe(0);expect(provider.starts).toBe(1);expect(provider.kills).toBe(0);
   expect(await f.sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE id=?").bind(f.delivery.workId).first()).toEqual(holders);
   expect(fresh.getSchedules().some(s=>s.callback==='maintainCfWorkLease')).toBe(true);
   expect(await state.storage.getAlarm()).not.toBeNull();
  } finally {errors.mockRestore();}
 });
});
it("cold duplicate dispatch cannot substitute a freshly issued holder for the running process",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const first=new SessionDO(state,c.configured as never);
  expect((await first.fetch(request(f.delivery))).status).toBe(200);
  const hashes=await f.sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE id=?").bind(f.delivery.workId).first();
  const fresh=new SessionDO(state,{...c.configured} as never);
  expect((await fresh.fetch(request(f.delivery))).status).toBe(409);
  expect(await f.sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE id=?").bind(f.delivery.workId).first()).toEqual(hashes);
  expect(provider.renewals).toBe(0);expect(provider.starts).toBe(1);expect(provider.kills).toBe(0);
 });
});
it("cold dispatch recovers a newer claim after the previous management process exited",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  expect((await new SessionDO(state,c.configured as never).fetch(request(f.delivery))).status).toBe(200);
  provider.slot.status="exited";
  await f.sql.prepare("UPDATE managed_environment_work SET claim_generation=3, claim_at=?, sandbox_token_hashes='[]' WHERE id=?").bind(Date.now(),f.delivery.workId).run();
  const capability=JSON.parse(atob(f.delivery.workSecret));
  const next={...f.delivery,workSecret:btoa(JSON.stringify({...capability,claim_generation:3}))};
  const fresh=new SessionDO(state,{...c.configured} as never);
  expect((await fresh.fetch(request(next))).status).toBe(200);
  expect(provider.starts).toBe(2);
  expect(provider.slot.identity.attemptId).toBe("environment-work-claim:3");
  expect(provider.slot.status).toBe("running");
 });
});
it.each(["same-claim", "scope", "unknown-work", "holder"])("cold successor rejects unproven handoff: %s",async mode=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  expect((await new SessionDO(state,c.configured as never).fetch(request(f.delivery))).status).toBe(200);
  provider.slot.status="exited";
  const generation=mode==="same-claim"?2:3;
  await f.sql.prepare("UPDATE managed_environment_work SET claim_generation=?, claim_at=? WHERE id=?").bind(generation,Date.now(),f.delivery.workId).run();
  if(mode==="scope")provider.slot.identity.sessionId="other-session";
  if(mode==="unknown-work")provider.slot.identity.workId="unknown-work";
  if(mode==="holder")provider.slot.holderHash="bad";
  const hashes=await f.sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE id=?").bind(f.delivery.workId).first();
  const capability=JSON.parse(atob(f.delivery.workSecret));
  const next={...f.delivery,workSecret:btoa(JSON.stringify({...capability,claim_generation:generation}))};
  expect((await new SessionDO(state,{...c.configured} as never).fetch(request(next))).status).toBe(409);
  expect(provider.starts).toBe(1);expect(provider.kills).toBe(0);
  expect(await f.sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE id=?").bind(f.delivery.workId).first()).toEqual(hashes);
 });
});
it("revoked old holder cleans only its exact process and removes only the Work wake",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);
  expect((await instance.fetch(request(f.delivery))).status).toBe(200);
  const other=await instance.schedule(3600,"recoverEventQueue",{});
  await f.sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes='[]' WHERE id=?").bind(f.delivery.workId).run();
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");
  await instance.alarm();
  expect(provider.kills).toBe(1);expect(provider.renewals).toBe(0);
  expect(instance.getSchedule(other.id)).toBeDefined();
  expect(instance.getSchedules().filter(s=>s.callback==='maintainCfWorkLease')).toHaveLength(0);
  expect(await state.storage.getAlarm()).not.toBeNull();
 });
});
it("a native renewal unresolved across two alarms stays single-flight and does not block exact loss cleanup",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);
  expect((await instance.fetch(request(f.delivery))).status).toBe(200);
  let release!:()=>void;provider.renewGate=new Promise<void>(resolve=>release=resolve);
  try {
   for(let n=0;n<2;n++) {
    state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");
    await instance.alarm();
    expect(provider.renewals).toBe(1);expect(provider.kills).toBe(0);
    expect(await state.storage.getAlarm()).not.toBeNull();
   }
   await f.sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes='[]' WHERE id=?").bind(f.delivery.workId).run();
   state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");
   await instance.alarm();expect(provider.kills).toBe(1);expect(provider.renewals).toBe(1);
  } finally {release();provider.renewGate=undefined;}
 });
});
it("Work dispatch does not initialize the MA event queue or run cold SessionExecution recovery",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);
  expect((await instance.fetch(request(f.delivery))).status).toBe(200);
  expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='events'").toArray()).toEqual([]);
 });
});
it("a new process acknowledgement restores the wake after an alarm retires the old holder during launch",async()=>{
 const f=await fixture(),c=await cold(f),nextId="next_"+crypto.randomUUID(),token=await f.insert(nextId,1);
 const next={...f.delivery,workId:nextId,workSecret:btoa(JSON.stringify({sessions_token:token,api_base_url:f.delivery.apiBaseUrl,claim_generation:1}))};
 const cipher=new WebCryptoAesGcm(c.configured.PLATFORM_ROOT_SECRET,"managed.environment-work.secret"),stored=await f.work.find(next);
 await f.sql.prepare("UPDATE managed_environment_work SET sealed_secret=? WHERE id=?").bind(await cipher.encrypt(JSON.stringify(stored!.secret)),nextId).run();
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const instance=new SessionDO(state,c.configured as never);
  expect((await instance.fetch(request(f.delivery))).status).toBe(200);
  // Launcher retains exact old handles after a successor occupies the slot.
  provider.slot.status="exited";
  await f.sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes='[]' WHERE id=?").bind(f.delivery.workId).run();
  let entered!:()=>void,release!:()=>void;
  const atRead=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
  provider.hold={entered,wait};
  const pending=instance.fetch(request(next));await atRead;
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");
  try {await instance.alarm();} finally {release();}
  expect((await pending).status).toBe(200);
  expect(instance.getSchedules().filter(s=>s.callback==='maintainCfWorkLease')).toHaveLength(1);
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");
  await instance.alarm();
  expect(provider.renewals).toBe(1);expect(provider.slot.status).toBe("running");
 });
});

it.each(["active","stopping"])("cold alarm recovers original exact holder in %s without connect/mint/launch",async status=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  const first=new SessionDO(state,c.configured as never);
  expect((await first.fetch(request(f.delivery))).status).toBe(200);
  await f.sql.prepare("UPDATE managed_environment_work SET state=? WHERE id=?").bind(status,f.delivery.workId).run();
  const before=await f.sql.prepare("SELECT * FROM managed_environment_work WHERE id=?").bind(f.delivery.workId).first();
  const connects=provider.connects;
  const fresh=new SessionDO(state,{...c.configured} as never);
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");
  await fresh.alarm();
  expect(provider.renewals).toBe(1);expect(provider.reads).toBe(1);
  expect(provider.connects).toBe(connects);expect(provider.creates).toBe(1);expect(provider.starts).toBe(1);expect(provider.kills).toBe(0);
  expect(await f.sql.prepare("SELECT * FROM managed_environment_work WHERE id=?").bind(f.delivery.workId).first()).toEqual(before);
  expect(await state.storage.getAlarm()).not.toBeNull();
 });
});
it.each(["paused","auto-resume","read-error"])("cold recovery refuses %s without side effects then retries",async mode=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  expect((await new SessionDO(state,c.configured as never).fetch(request(f.delivery))).status).toBe(200);
  provider.state=mode==="paused"?"paused":"running";provider.autoResume=mode==="auto-resume";provider.readFailure=mode==="read-error";
  const fresh=new SessionDO(state,{...c.configured} as never),connects=provider.connects;
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");await fresh.alarm();
  expect(provider.reads).toBe(1);expect(provider.connects).toBe(connects);expect(provider.kills).toBe(0);expect(provider.renewals).toBe(0);
  expect(await state.storage.getAlarm()).not.toBeNull();
  provider.state="running";provider.autoResume=false;provider.readFailure=false;
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");await fresh.alarm();
  expect(provider.renewals).toBe(1);expect(provider.starts).toBe(1);
 });
});

it.each(["revoked","expired","stopped","generation"])("cold alarm cleans only exact lost process: %s",async mode=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  expect((await new SessionDO(state,c.configured as never).fetch(request(f.delivery))).status).toBe(200);
  const patch=mode==="revoked"?"sandbox_token_hashes='[]'":mode==="expired"?"claim_at=0":mode==="stopped"?"state='stopped'":"claim_generation=3";
  await f.sql.prepare("UPDATE managed_environment_work SET "+patch+" WHERE id=?").bind(f.delivery.workId).run();
  const fresh=new SessionDO(state,{...c.configured} as never);
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");await fresh.alarm();
  expect(provider.kills).toBe(1);expect(provider.renewals).toBe(0);expect(provider.starts).toBe(1);
  expect(fresh.getSchedules().filter(s=>s.callback==='maintainCfWorkLease')).toHaveLength(0);
 });
});
it.each(["sandbox","identity","holder"])("cold alarm rejects forged locator %s without cleanup or renewal",async mode=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  expect((await new SessionDO(state,c.configured as never).fetch(request(f.delivery))).status).toBe(200);
  if(mode==="sandbox")provider.slot.sandboxId="other";
  if(mode==="identity")provider.slot.identity={...provider.slot.identity,sessionId:"other"};
  if(mode==="holder")provider.slot.holderHash="bad";
  const fresh=new SessionDO(state,{...c.configured} as never);
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");await fresh.alarm();
  expect(provider.kills).toBe(0);expect(provider.renewals).toBe(0);expect(provider.starts).toBe(1);
  expect(await state.storage.getAlarm()).not.toBeNull();
 });
});
it("cold restore status RPC stays single-flight across overlapping alarms",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  expect((await new SessionDO(state,c.configured as never).fetch(request(f.delivery))).status).toBe(200);
  let entered!:()=>void,release!:()=>void;
  const enteredPromise=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
  provider.hold={entered,wait,op:"status"};
  const fresh=new SessionDO(state,{...c.configured} as never);
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");
  const first=fresh.alarm();await enteredPromise;const second=fresh.alarm();
  await Promise.resolve();expect(provider.reads).toBe(1);expect(provider.renewals).toBe(0);
  release();await Promise.all([first,second]);expect(provider.renewals).toBe(1);expect(provider.starts).toBe(1);
 });
});
it("cold recovered old holder cannot kill successor occupying the physical slot",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  expect((await new SessionDO(state,c.configured as never).fetch(request(f.delivery))).status).toBe(200);
  const old=provider.slot;
  let entered!:()=>void,release!:()=>void;
  const reached=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
  provider.hold={entered,wait,op:"status"};
  const fresh=new SessionDO(state,{...c.configured} as never);
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");
  const alarm=fresh.alarm();await reached;
  await f.sql.prepare("UPDATE managed_environment_work SET claim_generation=3,sandbox_token_hashes='[]' WHERE id=?").bind(f.delivery.workId).run();
  provider.slot={...old,id:"successor",pid:42,identity:{...old.identity,attemptId:"environment-work-claim:3"}};
  provider.processes.set(provider.slot.id,provider.slot);
  release();await alarm;
  expect(old.status).toBe("exited");expect(provider.slot.status).toBe("running");expect(provider.kills).toBe(1);expect(provider.renewals).toBe(0);
 });
});
it("cold SQL read failure is unknown rather than loss and the next alarm retries",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  expect((await new SessionDO(state,c.configured as never).fetch(request(f.delivery))).status).toBe(200);
  const fresh=new SessionDO(state,{...c.configured} as never);
  const read=vi.spyOn(SqlEnvironmentWorkStore.prototype,"find").mockRejectedValueOnce(Error("SQL unavailable"));
  try {
   state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");await fresh.alarm();
   expect(provider.kills).toBe(0);expect(provider.renewals).toBe(0);expect(await state.storage.getAlarm()).not.toBeNull();
  } finally {read.mockRestore();}
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");await fresh.alarm();expect(provider.renewals).toBe(1);
 });
});
it("cold alarm never renews an exited management process even while SQL claim is live",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  expect((await new SessionDO(state,c.configured as never).fetch(request(f.delivery))).status).toBe(200);
  provider.slot.status="exited";
  const fresh=new SessionDO(state,{...c.configured} as never);
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");await fresh.alarm();
  expect(provider.renewals).toBe(0);expect(provider.kills).toBe(0);expect(provider.starts).toBe(1);
 });
});
it("dispatch after successful cold maintenance cannot rotate the recovered process holder",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  expect((await new SessionDO(state,c.configured as never).fetch(request(f.delivery))).status).toBe(200);
  const fresh=new SessionDO(state,{...c.configured} as never);
  state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");await fresh.alarm();
  expect(provider.renewals).toBe(1);
  const row=await f.sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE id=?").bind(f.delivery.workId).first();
  expect((await fresh.fetch(request(f.delivery))).status).toBe(409);
  expect(await f.sql.prepare("SELECT sandbox_token_hashes FROM managed_environment_work WHERE id=?").bind(f.delivery.workId).first()).toEqual(row);
  expect(provider.starts).toBe(1);expect(provider.kills).toBe(0);
 });
});
it("cold recovered unresolved renewal is single-flight across timeout/retry and loss",async()=>{
 const f=await fixture(),c=await cold(f);
 await runInDurableObject(c.stub,async(_instance,state)=>{
  expect((await new SessionDO(state,c.configured as never).fetch(request(f.delivery))).status).toBe(200);
  const fresh=new SessionDO(state,{...c.configured} as never);
  let release!:()=>void;provider.renewGate=new Promise<void>(resolve=>release=resolve);
  try {
   for(let i=0;i<2;i++) {
    state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");await fresh.alarm();
    expect(provider.reads).toBe(1);expect(provider.renewals).toBe(1);expect(provider.kills).toBe(0);
    expect(await state.storage.getAlarm()).not.toBeNull();
   }
   await f.sql.prepare("UPDATE managed_environment_work SET sandbox_token_hashes='[]' WHERE id=?").bind(f.delivery.workId).run();
   state.storage.sql.exec("UPDATE cf_agents_schedules SET time=0 WHERE callback='maintainCfWorkLease'");await fresh.alarm();
   expect(provider.kills).toBe(1);expect(provider.renewals).toBe(1);
  } finally {release();provider.renewGate=undefined;}
 });
});
