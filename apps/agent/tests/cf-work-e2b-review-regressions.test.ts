import { preparedAcpFixture } from "./prepared-acp-fixture";
import { env, exports } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { startE2BWorkProcess } from "../src/runtime/e2b-work-handoff";
import { createCfWorkRunnerDispatch } from "../src/runtime/cf-work-runner-dispatch";
import { createCfWorkRunnerAuthority } from "../../main/src/lib/cf-work-runner-authority";
import { attemptSandboxTokens, generateSandboxToken } from "@open-managed-agents/sandbox-gateway";
import { seedSandboxGatewaySessionRows } from "../../../packages/sandbox-gateway/test/gateway-store-conformance";

beforeAll(async () => { await exports.default.fetch(new Request("http://localhost/health")); });
async function fixture() {
  const sql = new CfD1SqlClient(env.MAIN_DB), suffix = crypto.randomUUID();
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
function native(identity:object, onStatus:()=>void|Promise<void>=()=>{}) {
  const calls:string[]=[]; let starts=0,killed=false;
  const locator={sandboxId:"physical",id:"3b3aa158-7fca-4e84-bc89-5cd17d1381eb",epoch:"trusted-epoch",pid:19,status:"running",identity};
  const handle={id:locator.id,pid:19,kill:async()=>{calls.push("kill");killed=true;},getStatus:async()=>{calls.push("status");await onStatus();return killed?"exited":"running";}};
  const runtime={runtimeHandle:()=>({provider:"e2b",runtimeId:"physical"}),startManagedProcess:async()=>{calls.push("start");if(++starts===1)throw Object.assign(Error("management worker busy"),{outcome:"rejected"});return handle;},inspectManagedProcessSlot:async()=>{calls.push("inspect");return locator;},restoreManagedProcess:async(target:unknown)=>{expect(target).toBe(locator);calls.push("restore");return handle;}};
  return {calls,runtime};
}
const spec={command:"/usr/local/bin/node",args:[],env:{}};
it("real D1 active to stopped exposes claim:null but retires the exact old attempt using retained terminal generation",async()=>{
  const f=await fixture(),oldId="old_"+crypto.randomUUID();await f.insert(oldId,1);
  const old=await f.work.find({...f.delivery,workId:oldId});expect(old?.claim?.generation).toBe(1);
  const result=await f.work.replace({...f.delivery,workId:oldId,expectedRevision:old!.revision,next:{...old!,work:{...old!.work,state:"stopped",stoppedAt:new Date().toISOString()},claim:null}});expect(result.type).toBe("replaced");
  expect((await f.work.find({...f.delivery,workId:oldId}))?.claim).toBeNull();
  const row=await f.sql.prepare("SELECT claim_generation FROM managed_environment_work WHERE workspace_id='default' AND id=?").bind(oldId).first<any>();expect(row.claim_generation).toBe(1);
  const n=native({...f.identity,workId:oldId,attemptId:"environment-work-claim:1"});
  await startE2BWorkProcess({runtime:n.runtime,work:f.work,sql:f.sql,delivery:f.delivery,identity:f.identity,spec,assertCurrent:async()=>{expect(await f.authorize(f.delivery)).not.toBeNull();}} as never);
  expect(n.calls).toEqual(["start","inspect","restore","kill","status","start"]);
});
it.each([false,true])("same-claim reconnect request cancellation never kills a current worker; actual claim loss does (lost=%s)",async lost=>{
  const f=await fixture(),ac=new AbortController();
  const n=native(f.identity,async()=>{if(lost)await f.sql.prepare("UPDATE managed_environment_work SET state='stopped' WHERE workspace_id='default' AND id=?").bind(f.delivery.workId).run();ac.abort(Error("duplicate cancelled"));});
  const dispatcher=createCfWorkRunnerDispatch({command:"unused",tokens:attemptSandboxTokens(),issueToken:async()=>generateSandboxToken(),authorize:f.authorize,
    sandbox:async(_d,authority)=>({provider:"e2b",preparedAcp:preparedAcpFixture("codex-acp","1.8.0"),runtimeHandle:n.runtime.runtimeHandle,startManagedProcess:(spec,identity)=>startE2BWorkProcess({runtime:n.runtime,work:f.work,sql:f.sql,delivery:f.delivery,spec,identity,assertCurrent:authority.assertCurrent} as never)})});
  await expect(dispatcher.dispatch({...f.delivery,signal:ac.signal})).rejects.toThrow("duplicate cancelled");
  expect((await f.authorize(f.delivery))===null).toBe(lost);
  expect(n.calls).toEqual(lost?["start","inspect","restore","status","kill"]:["start","inspect","restore","status"]);
});

it.each(["future-generation","missing-row","foreign-session"] as const)("terminal locator %s cannot obtain cleanup authority from stopped alone",async mode=>{
 const f=await fixture(),oldId="old_"+crypto.randomUUID();await f.insert(oldId,1);
 const old=await f.work.find({...f.delivery,workId:oldId});
 await f.work.replace({...f.delivery,workId:oldId,expectedRevision:old!.revision,next:{...old!,work:{...old!.work,state:"stopped"},claim:null}});
 if(mode==="missing-row")await f.sql.prepare("DELETE FROM managed_environment_work WHERE workspace_id='default' AND id=?").bind(oldId).run();
 if(mode==="foreign-session")await f.sql.prepare("UPDATE managed_environment_work SET session_id='foreign' WHERE workspace_id='default' AND id=?").bind(oldId).run();
 const n=native({...f.identity,workId:oldId,attemptId:mode==="future-generation"?"environment-work-claim:3":"environment-work-claim:1"});
 await expect(startE2BWorkProcess({runtime:n.runtime,work:f.work,sql:f.sql,delivery:f.delivery,identity:f.identity,spec,assertCurrent:async()=>{}} as never)).rejects.toThrow("authority is unknown");
 expect(n.calls).toEqual(["start","inspect"]);
});
it("duplicate cancellation plus unavailable authority is unknown, never permission to kill the existing worker",async()=>{
 const f=await fixture(),ac=new AbortController();let unavailable=false;
 const n=native(f.identity,()=>{unavailable=true;ac.abort(Error("cancel duplicate"));});
 const dispatcher=createCfWorkRunnerDispatch({command:"unused",tokens:attemptSandboxTokens(),issueToken:async()=>generateSandboxToken(),authorize:async delivery=>{if(unavailable)throw Error("authority unavailable");return f.authorize(delivery);},sandbox:async(_d,authority)=>({provider:"e2b",preparedAcp:preparedAcpFixture("codex-acp","1.8.0"),runtimeHandle:n.runtime.runtimeHandle,startManagedProcess:(spec,identity)=>startE2BWorkProcess({runtime:n.runtime,work:f.work,sql:f.sql,delivery:f.delivery,spec,identity,assertCurrent:authority.assertCurrent} as never)})});
 await expect(dispatcher.dispatch({...f.delivery,signal:ac.signal})).rejects.toThrow("authority unavailable");
 expect(n.calls).toEqual(["start","inspect","restore","status"]);
});
