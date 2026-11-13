import { createRequire } from "node:module";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { buildWorkFinalizationRoutes } from "../../http-routes/src/work-finalization";
import { afterAll, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient, type SqlStatement } from "@open-managed-agents/sql-client";
import { WorkFinalizationApplication } from "../../managed-agents-application/src/work-finalization/application";
import { SqlWorkFinalization } from "../src/work-finalization";
import type { WorkFinalizationHostPort } from "../../managed-agents-application/src/work-finalization/ports";

const claim = {workspaceId:"ws",environmentId:"env",sessionId:"s",workId:"w",generation:2,holder:"worker"};
const now = "2026-11-10T00:00:00.000Z";
async function fixture(client?:SqlClient) {
 const sql=client??await createBetterSqlite3SqlClient(":memory:");
 await sql.exec(`CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,document TEXT,revision INTEGER,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,environment_id TEXT,agent_id TEXT,agent_version INTEGER,deployment_id TEXT,status TEXT,PRIMARY KEY(workspace_id,id));
 CREATE TABLE managed_environment_work(workspace_id TEXT,environment_id TEXT,id TEXT,session_id TEXT,state TEXT,claim_generation INTEGER,claim_at INTEGER,heartbeat_ttl_seconds INTEGER,revision INTEGER,document TEXT,claim_worker_id TEXT,created_at INTEGER,PRIMARY KEY(workspace_id,id));
 CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,thread_id TEXT,id TEXT,type TEXT,document TEXT,processed_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));
 CREATE TABLE managed_session_initial_events(workspace_id TEXT,session_id TEXT,sequence INTEGER,document TEXT,PRIMARY KEY(workspace_id,session_id,sequence));`);
 const session={id:"s",agent:{id:"agent",version:1,name:"Agent"},environmentId:"env",deploymentId:null,status:"running",createdAt:now,updatedAt:now,archivedAt:null,budget:null,usage:{},outcomeEvaluations:[]};
 await sql.prepare("INSERT INTO managed_sessions VALUES ('ws','s',?,3,0,0,NULL,'env','agent',1,NULL,'running')").bind(JSON.stringify(session)).run();
 await sql.prepare("INSERT INTO managed_environment_work VALUES ('ws','env','w','s','active',2,?,90,1,'{}','worker',0)").bind(Date.now()).run();
 const insert=async(event:object,revision:number,source:object={})=>{
  const e=event as {id:string;type:string};
  await sql.prepare("INSERT INTO managed_session_events VALUES ('ws','s',NULL,?,?,?,0)").bind(e.id,e.type,JSON.stringify({...event,source_position:{revision,index:0,...source}})).run();
 };
 await insert({id:"input",type:"user.message",processedAt:now,content:[]},2,{consumed_by_execution_id:"input"});
 const trace:string[]=[];
 let prepare:WorkFinalizationHostPort["prepare"]=async scope=>{expect(await scope.isCurrent()).toBe(true);trace.push("storage+checkpoint");return {type:"prepared"};};
 let publish:WorkFinalizationHostPort["publish"]=async scope=>{expect(await scope.isCurrent()).toBe(true);trace.push("artifacts");return {type:"published"};};
 const host:WorkFinalizationHostPort={prepare:scope=>prepare(scope),publish:scope=>publish(scope)};
 const store=new SqlWorkFinalization(sql);
 const app=new WorkFinalizationApplication({persistence:store,host,now:()=>new Date(now)});
 return {sql,insert,trace,store,app,host,setPrepare:(fn:typeof prepare)=>{prepare=fn;},setPublish:(fn:typeof publish)=>{publish=fn;}};
}
const request={claim,turnId:"input",revision:3,stopReason:{type:"end_turn" as const}};
const events=async(sql:SqlClient)=>(await sql.prepare("SELECT document FROM managed_session_events WHERE type='session.status_idle'").all<{document:string}>()).results!.map(r=>JSON.parse(r.document));

describe("Work finalization canonical boundary",()=>{
 it("runs a real host storage barrier before the canonical terminal and publishes artifacts only afterward",async()=>{
  const f=await fixture();f.setPrepare(async scope=>{expect(scope.claim).toEqual(claim);expect(scope.turnId).toBe("input");expect(await events(f.sql)).toEqual([]);return {type:"prepared"};});
  const result=await f.app.finalize(request);expect(result.type).toBe("committed");
  const terminal=(await events(f.sql))[0];expect(terminal.source_position.execution_id).toBe("input");expect(terminal.source_position.environment_work).toEqual({workId:"w",generation:2});
  const plan=await f.app.recover({claim,turnId:"input"});expect(plan).toMatchObject({type:"committed",revision:4,terminal:{eventId:terminal.id,turnId:"input",generation:2,stopReason:{type:"end_turn"}}});
  f.setPublish(async scope=>{expect(scope.terminal.eventId).toBe(terminal.id);expect((await events(f.sql)).length).toBe(1);return {type:"published"};});
  expect(await f.app.publish({claim,turnId:"input",revision:4,terminalEventId:terminal.id})).toMatchObject({type:"published",terminal:{eventId:terminal.id}});
 });
 it("does not mistake a previous idle or a dispatch-without-terminal for permission to replay a consumed turn",async()=>{
  const f=await fixture();expect(await f.app.recover({claim,turnId:"input"})).toMatchObject({type:"gap",reason:"consumed_turn_without_terminal"});
  await f.insert({id:"old-idle",type:"session.status_idle",processedAt:now,stopReason:{type:"end_turn"}},1,{execution_id:"older",environment_work:{workId:"w",generation:1}});
  expect(await f.app.recover({claim,turnId:"input"})).toMatchObject({type:"gap"});
  await f.insert({id:"new",type:"user.message",processedAt:null,content:[]},3);
  expect(await f.app.recover({claim,turnId:"new"})).toMatchObject({type:"run",revision:3,turnId:"new"});
 });
 it("requires canonical turn attribution, including bootstrap input, not a caller-chosen turn or latest idle",async()=>{
  const f=await fixture();expect(await f.app.finalize({...request,turnId:"w:2"})).toMatchObject({type:"rejected"});
  await f.sql.exec("DELETE FROM managed_session_events");
  await f.sql.prepare("INSERT INTO managed_session_initial_events VALUES ('ws','s',0,?)").bind(JSON.stringify({id:"bootstrap_s:0",type:"user.message",content:[],processedAt:now,source_position:{revision:1,index:0,consumed_by_execution_id:"bootstrap_s:0"}})).run();
  expect(await f.app.finalize({...request,turnId:"bootstrap_s:0"})).toMatchObject({type:"committed"});
 });
 it.each(["requires_action","budget_reached"])("keeps %s parked instead of declaring cleanup-only completion",async type=>{
  const f=await fixture();await f.app.finalize({...request,stopReason:type==="requires_action"?{type,eventIds:["call"]}:{type:"budget_reached"}});
  expect(await f.app.recover({claim,turnId:"input"})).toMatchObject({type:"parked",terminal:{stopReason:{type}}});
 });
 it("retains original exhausted outcome after reclaim and never prepares or runs again",async()=>{
  const f=await fixture();expect(await f.app.fail({...request,phase:"run"})).toMatchObject({type:"committed",terminal:{stopReason:{type:"retries_exhausted"}}});
  await f.sql.exec("UPDATE managed_environment_work SET claim_generation=3,claim_worker_id='next'");
  f.setPrepare(async()=>{throw Error("must not run");});
  expect(await f.app.recover({claim:{...claim,generation:3,holder:"next"},turnId:"input"})).toMatchObject({type:"committed",terminal:{generation:2,stopReason:{type:"retries_exhausted"}}});
  expect(await f.app.recover({claim,turnId:"input"})).toMatchObject({type:"rejected"});
 });
 it("recovers and publishes an exact completed turn without consuming its queued successor",async()=>{
  const f=await fixture();await f.app.finalize(request);const terminal=(await events(f.sql))[0];
  await f.insert({id:"new",type:"user.message",processedAt:null,content:[]},5);await f.sql.exec("UPDATE managed_sessions SET revision=5,status='running'");
  const queued = await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='new'").first();
  expect(await f.app.recover({claim,turnId:"input"})).toMatchObject({type:"committed",terminal:{eventId:terminal.id}});
  expect(await f.app.publish({claim,turnId:"input",revision:5,terminalEventId:terminal.id})).toMatchObject({type:"published"});
  expect(await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='new'").first()).toEqual(queued);
  expect(await f.sql.prepare("SELECT state FROM managed_environment_work").first()).toEqual({state:"active"});
 });
 it("fails closed without a host implementation and does not trust completion claims",async()=>{
  const f=await fixture();const app=new WorkFinalizationApplication({persistence:f.store});
  expect(await app.finalize(request)).toMatchObject({type:"unavailable",phase:"finalization"});expect(await events(f.sql)).toEqual([]);
 });
 it("settles a pre-terminal host failure as exhausted finalization, never startup",async()=>{
  const f=await fixture();f.setPrepare(async()=>{throw Error("private storage error");});
  expect(await f.app.finalize(request)).toMatchObject({type:"failed",phase:"finalization",terminal:{stopReason:{type:"retries_exhausted"}}});
  expect(JSON.stringify(await events(f.sql))).not.toContain("private storage error");
 });
 it.each(["claim","holder","revision"])("rejects a concurrent %s change during the actual host barrier",async change=>{
  const f=await fixture();f.setPrepare(async scope=>{await f.sql.exec(change==="claim"?"UPDATE managed_environment_work SET claim_generation=3":change==="holder"?"UPDATE managed_environment_work SET claim_worker_id='new'":"UPDATE managed_sessions SET revision=4");expect(await scope.isCurrent()).toBe(false);return {type:"prepared"};});
  expect(await f.app.finalize(request)).toMatchObject({type:"rejected"});expect(await events(f.sql)).toEqual([]);
 });
 it("rejects old artifact response after reclaim without replacing original terminal",async()=>{
  const f=await fixture();await f.app.finalize(request);const terminal=(await events(f.sql))[0];
  f.setPublish(async()=>{await f.sql.exec("UPDATE managed_environment_work SET claim_generation=3");return {type:"published"};});
  expect(await f.app.publish({claim,turnId:"input",revision:4,terminalEventId:terminal.id})).toMatchObject({type:"rejected"});expect(await events(f.sql)).toHaveLength(1);
 });
 it("retains committed outcome when post-terminal publication fails and retries cleanup only",async()=>{
  const f=await fixture();await f.app.finalize(request);const terminal=(await events(f.sql))[0];
  f.setPublish(async()=>{throw Error("blob unavailable");});
  expect(await f.app.publish({claim,turnId:"input",revision:4,terminalEventId:terminal.id})).toMatchObject({type:"failed",phase:"finalization",terminal:{stopReason:{type:"end_turn"}}});
  expect(await f.app.fail({...request,revision:4,phase:"finalization"})).toMatchObject({type:"committed",terminal:{stopReason:{type:"end_turn"}}});expect(await events(f.sql)).toHaveLength(1);
 });
 it("rolls back terminal when claim changes at the SQL CAS rather than trusting preflight",async()=>{
  const f=await fixture();let inject=true;
  const intercept=async()=>{if(inject){inject=false;await f.sql.exec("UPDATE managed_environment_work SET claim_worker_id='new'");}};
  const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:async<T>(ss:SqlStatement[])=>{await intercept();return f.sql.batch<T>(ss);},...(f.sql.batchChecked?{batchChecked:async(ss,validate)=>{await intercept();return f.sql.batchChecked!(ss,validate);}}:{})};
  const app=new WorkFinalizationApplication({persistence:new SqlWorkFinalization(sql),host:f.host});
  expect(await app.finalize(request)).toMatchObject({type:"rejected"});expect(await events(f.sql)).toEqual([]);
 });
});
it("checkpoint acknowledges physical persistence without prematurely publishing terminal",async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let finished=false;
 f.setPrepare(async()=>{await gate;finished=true;return {type:"prepared"};});
 const pending=f.app.checkpoint(request);await Promise.resolve();expect(finished).toBe(false);expect(await events(f.sql)).toEqual([]);
 release();expect(await pending).toMatchObject({type:"prepared",revision:3,turnId:"input"});expect(finished).toBe(true);expect(await events(f.sql)).toEqual([]);
});
it("recovers a lost persistence response from exact canonical receipt without rerunning host barrier",async()=>{
 const f=await fixture();let lost=true;
 const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:ss=>f.sql.batch(ss),batchChecked:async(ss,validate)=>{const result=await f.sql.batchChecked!(ss,validate);if(lost){lost=false;throw Error("response lost");}return result;}};
 const app=new WorkFinalizationApplication({persistence:new SqlWorkFinalization(sql),host:f.host});
 await expect(app.finalize(request)).rejects.toThrow("response lost");
 expect(await app.recover({claim,turnId:"input"})).toMatchObject({type:"committed",terminal:{turnId:"input",stopReason:{type:"end_turn"}}});expect(f.trace).toEqual(["storage+checkpoint"]);
});
it("rejects TTL expiry before transaction even if application preflight succeeded",async()=>{
 const f=await fixture();let inject=true;const before=async()=>{if(inject){inject=false;await f.sql.exec("UPDATE managed_environment_work SET claim_at=0");}};
 const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:async ss=>{await before();return f.sql.batch(ss);},batchChecked:async(ss,validate)=>{await before();return f.sql.batchChecked!(ss,validate);}};
 expect(await new WorkFinalizationApplication({persistence:new SqlWorkFinalization(sql),host:f.host}).finalize(request)).toMatchObject({type:"rejected"});expect(await events(f.sql)).toEqual([]);
});
it("does not authorize a new model turn from a partial parked answer or a budget pause",async()=>{
 const f=await fixture();await f.app.finalize({...request,stopReason:{type:"requires_action",eventIds:["a","b"]}});
 await f.insert({id:"answer",type:"user.custom_tool_result",customToolUseId:"a",processedAt:null,content:[]},5);await f.sql.exec("UPDATE managed_sessions SET revision=5");
 expect(await f.app.recover({claim,turnId:"answer"})).toMatchObject({type:"gap",reason:"requires_action_pending"});
});
it("rejects unattributed legacy terminal rather than silently using session idle",async()=>{
 const f=await fixture();await f.insert({id:"legacy",type:"session.status_idle",processedAt:now,stopReason:{type:"end_turn"}},3,{environment_work:{workId:"w",generation:2}});
 expect(await f.app.recover({claim,turnId:"input"})).toMatchObject({type:"gap"});
});
it("does not declare a turn completed when later canonical turn facts follow its idle",async()=>{
 const f=await fixture();await f.app.finalize(request);await f.insert({id:"late",type:"agent.message",content:[],processedAt:now},5,{execution_id:"input",environment_work:{workId:"w",generation:2}});await f.sql.exec("UPDATE managed_sessions SET revision=5");
 expect(await f.app.recover({claim,turnId:"input"})).toMatchObject({type:"gap",reason:"terminal_not_last_turn_fact"});
});

it("HTTP terminal ACK joins real host barrier and canonical SQL; stale replay cannot overwrite",async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 f.setPrepare(async()=>{await gate;return {type:"prepared"};});
 const route=buildWorkFinalizationRoutes({authenticate:async()=>claim,applicationFor:async()=>f.app});
 const send=async(action:string,body:object)=>route.request(`/s/${action}`,{method:"POST",headers:{authorization:"Bearer sealed","content-type":"application/json"},body:JSON.stringify(body)});
 let answered=false;const pending=send("work-finalize",{turnId:"input",revision:3,stopReason:{type:"end_turn"}}).then(r=>{answered=true;return r;});
 await Promise.resolve();expect(answered).toBe(false);expect(await events(f.sql)).toEqual([]);release();
 const response=await pending;expect(response.status).toBe(200);const result=await response.json() as {terminal:{eventId:string}};
 expect((await events(f.sql))[0].id).toBe(result.terminal.eventId);
 const recovered=await send("work-recovery",{turnId:"input"});expect(await recovered.json()).toMatchObject({type:"committed",terminal:{eventId:result.terminal.eventId}});
 await f.sql.exec("UPDATE managed_environment_work SET claim_worker_id='new'");
 expect((await send("work-publish",{turnId:"input",revision:4,terminalEventId:result.terminal.eventId})).status).toBe(409);
});
it("rolls back earlier event inserts when final Session CAS fails inside the transaction",async()=>{
 const f=await fixture();let inject=true;
 const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:ss=>f.sql.batch(ss),batchChecked:async(ss,validate)=>{
   if(!inject)return f.sql.batchChecked!(ss,validate);inject=false;
   const statements=[...ss.slice(0,-1),f.sql.prepare("UPDATE managed_sessions SET revision=revision+1"),ss.at(-1)!];
   return f.sql.batchChecked!(statements,rows=>validate([...rows.slice(0,-2),rows.at(-1)!]));
 }};
 expect(await new WorkFinalizationApplication({persistence:new SqlWorkFinalization(sql),host:f.host}).finalize(request)).toMatchObject({type:"rejected"});
 expect(await events(f.sql)).toEqual([]);expect(await f.sql.prepare("SELECT revision FROM managed_sessions").first()).toEqual({revision:3});
});
const instances:Array<{dispose():Promise<void>}>=[];
afterAll(async()=>{for(const mf of instances)await mf.dispose();});
it("real workerd D1 commits exact terminal and aborts all writes on a CAS conflict",async()=>{
 const require=createRequire(import.meta.url);const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve("wrangler/package.json"))("miniflare");
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:"2026-11-01",d1Databases:["DB"]}));instances.push(mf);
 const f=await fixture(new CfD1SqlClient(await mf.getD1Database("DB")));
 expect(await f.app.finalize(request)).toMatchObject({type:"committed",terminal:{turnId:"input",generation:2}});
 expect(await f.app.recover({claim,turnId:"input"})).toMatchObject({type:"committed"});
 await f.sql.exec("DELETE FROM managed_session_events WHERE type='session.status_idle';UPDATE managed_sessions SET revision=3");
 let inject=true;
 const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:async ss=>{
   if(!inject)return f.sql.batch(ss);inject=false;
   // Inject after event INSERT + its changes assertion, before final update.
   return f.sql.batch([...ss.slice(0,-2),f.sql.prepare("UPDATE managed_sessions SET revision=revision+1"),...ss.slice(-2)]);
 }};
 expect(await new WorkFinalizationApplication({persistence:new SqlWorkFinalization(sql),host:f.host}).finalize(request)).toMatchObject({type:"rejected"});
 expect(await events(f.sql)).toEqual([]);expect(await f.sql.prepare("SELECT revision FROM managed_sessions").first()).toEqual({revision:3});
});
it("uses canonical budget normalization rather than caller end_turn and never starts at an exhausted cap",async()=>{
 const f=await fixture();await f.sql.exec("CREATE TABLE managed_session_threads(workspace_id TEXT,session_id TEXT,id TEXT,document TEXT,updated_at INTEGER)");
 const row=await f.sql.prepare("SELECT document FROM managed_sessions").first<{document:string}>();
 const doc={...JSON.parse(row!.document),budget:{amountMinor:"1",currency:"USD"},usage:{listCost:{amountMinor:"1",currency:"USD"}}};
 await f.sql.prepare("UPDATE managed_sessions SET document=?").bind(JSON.stringify(doc)).run();
 expect(await f.app.finalize(request)).toMatchObject({type:"parked",terminal:{stopReason:{type:"budget_reached"}}});
 await f.insert({id:"resume",type:"session.updated",resume:true,processedAt:null},5);await f.sql.exec("UPDATE managed_sessions SET revision=5");
 expect(await f.app.recover({claim,turnId:"resume"})).toMatchObject({type:"gap",reason:"budget_paused"});
 await f.sql.prepare("UPDATE managed_sessions SET document=?").bind(JSON.stringify({...doc,budget:{amountMinor:"2",currency:"USD"}})).run();
 expect(await f.app.recover({claim,turnId:"resume"})).toMatchObject({type:"run",turnId:"resume"});
});
it("two concurrent finalizations retain exactly one immutable canonical terminal",async()=>{
 const f=await fixture();const results=await Promise.all([f.app.finalize(request),f.app.finalize(request)]);
 expect(results.some(r=>r.type==="committed")).toBe(true);expect(await events(f.sql)).toHaveLength(1);
});
it("concurrent canonical input acceptance between barrier and terminal CAS prevents old terminal writes",async()=>{
 const f=await fixture();f.setPrepare(async()=>{await f.insert({id:"incoming",type:"user.message",content:[],processedAt:null},4);await f.sql.exec("UPDATE managed_sessions SET revision=4");return {type:"prepared"};});
 expect(await f.app.finalize(request)).toMatchObject({type:"rejected",reason:"turn_revision"});expect(await events(f.sql)).toEqual([]);
});
it("unavailable host publication is explicit and never reports publication success",async()=>{
 const f=await fixture();await f.app.finalize(request);const terminal=(await events(f.sql))[0];f.setPublish(async()=>({type:"unavailable"}));
 expect(await f.app.publish({claim,turnId:"input",revision:4,terminalEventId:terminal.id})).toEqual({type:"unavailable",phase:"finalization"});
});

// Consumption ownership is an existing canonical field, not the input's own
// admission ID and never a local supervisor admitted-set assertion.
it.each(["user.tool_confirmation","user.message"])("finalizes original root with canonically absorbed %s without relabeling root",async type=>{
 const f=await fixture();await f.insert({id:"absorbed",type,processedAt:now,content:[],toolUseId:"tool",result:"allow"},4,
  {execution_id:"dispatch-absorbed",consumed_by_execution_id:"input"});await f.sql.exec("UPDATE managed_sessions SET revision=4");
 expect(await f.app.recover({claim,turnId:"input"})).toMatchObject({type:"gap",reason:"consumed_turn_without_terminal",revision:4});
 const result=await f.app.finalize({...request,revision:4});expect(result).toMatchObject({type:"committed",terminal:{turnId:"input"}});
 const raw=await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='absorbed'").first<{document:string}>();
 expect(JSON.parse(raw!.document).source_position).toMatchObject({execution_id:"dispatch-absorbed",consumed_by_execution_id:"input"});
 expect(await f.app.recover({claim,turnId:"dispatch-absorbed"})).toMatchObject({type:"rejected"});
});
it.each(["dispatch-absorbed","another-root"])("does not treat successor consumption %s as belonging to root",async consumer=>{
 const f=await fixture();await f.insert({id:"absorbed",type:"user.message",processedAt:consumer?now:null,content:[]},4,
  {execution_id:"dispatch-absorbed",...(consumer?{consumed_by_execution_id:consumer}:{})});await f.sql.exec("UPDATE managed_sessions SET revision=4");
 expect(await f.app.finalize({...request,revision:4})).toMatchObject({type:"rejected",reason:"newer_input"});expect(await events(f.sql)).toEqual([]);
});
it.each([{processedAt:null},{processedAt:"invalid"},{processedAt:now,cancelled_at_ms:1},{processedAt:now,_queued:true},{processedAt:now,deferredUntilToolResults:["tool"]}])("does not authorize an invalid absorbed marker %j",async fields=>{
 const f=await fixture();await f.insert({id:"absorbed",type:"user.message",content:[],...fields},4,{execution_id:"dispatch-absorbed",consumed_by_execution_id:"input"});await f.sql.exec("UPDATE managed_sessions SET revision=4");
 expect(await f.app.finalize({...request,revision:4})).toMatchObject({type:"rejected",reason:"newer_input"});
});
it("absorbed input cannot bypass lost authority; queued successor survives root completion",async()=>{
 const f=await fixture();await f.insert({id:"absorbed",type:"user.message",processedAt:now,content:[]},4,{execution_id:"dispatch-absorbed",consumed_by_execution_id:"input"});await f.sql.exec("UPDATE managed_sessions SET revision=4");
 expect(await f.app.recover({claim:{...claim,holder:"old"},turnId:"input"})).toMatchObject({type:"rejected",reason:"claim"});
 expect(await f.app.recover({claim:{...claim,generation:1},turnId:"input"})).toMatchObject({type:"rejected",reason:"claim"});
 await f.insert({id:"next",type:"user.message",processedAt:null,content:[]},5);await f.sql.exec("UPDATE managed_sessions SET revision=5");
 const queued = await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='next'").first();
 expect(await f.app.finalize({...request,revision:5})).toMatchObject({type:"committed"});
 expect(await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='next'").first()).toEqual(queued);
 expect(await f.sql.prepare("SELECT state FROM managed_environment_work").first()).toEqual({state:"active"});
});
it("reassignment after host barrier loses revision CAS rather than finalizing over another turn",async()=>{
 const f=await fixture();await f.insert({id:"absorbed",type:"user.message",processedAt:now,content:[]},4,{execution_id:"dispatch-absorbed",consumed_by_execution_id:"input"});await f.sql.exec("UPDATE managed_sessions SET revision=4");
 f.setPrepare(async()=>{await f.sql.exec("UPDATE managed_session_events SET document=json_set(document,'$.source_position.consumed_by_execution_id','another-root') WHERE id='absorbed';UPDATE managed_sessions SET revision=5");return {type:"prepared"};});
 expect(await f.app.finalize({...request,revision:4})).toMatchObject({type:"rejected"});expect(await events(f.sql)).toEqual([]);
});
it("HTTP finalization preserves canonical original-turn receipt with absorbed confirmation and fences a stale owner",async()=>{
 const f=await fixture();
 // Canonical persistence fixture for the proposed producer contract, NOT a
 // supervisor consume integration or an assertion that producer already writes it.
 await f.insert({id:"confirmed",type:"user.tool_confirmation",toolUseId:"tool",result:"allow",processedAt:now},4,
  {execution_id:"dispatch-confirmed",consumed_by_execution_id:"input"});await f.sql.exec("UPDATE managed_sessions SET revision=4");
 const route=buildWorkFinalizationRoutes({authenticate:async()=>claim,applicationFor:async()=>f.app});
 const send=async(action:string,body:object)=>route.request(`/s/${action}`,{method:"POST",headers:{authorization:"Bearer work","content-type":"application/json"},body:JSON.stringify(body)});
 const recovery=await send("work-recovery",{turnId:"input"});expect(recovery.status).toBe(409);
 expect(await recovery.json()).toMatchObject({type:"gap",reason:"consumed_turn_without_terminal",revision:4});
 const finalized=await send("work-finalize",{turnId:"input",revision:4,stopReason:{type:"end_turn"}});expect(finalized.status).toBe(200);
 const body=await finalized.json() as {terminal:{eventId:string}};
 expect((await events(f.sql))[0].source_position.execution_id).toBe("input");
 await f.sql.exec("UPDATE managed_environment_work SET claim_generation=3");
 expect((await send("work-publish",{turnId:"input",revision:5,terminalEventId:body.terminal.eventId})).status).toBe(409);
});

// A turn terminal is not a whole-Work stop. A queued successor must survive
// finalization and remain independently runnable under the same live claim.
it("finalizes a consumed turn while preserving its unconsumed successor and resident Work", async () => {
 const f = await fixture();
 await f.insert({id:"next",type:"user.message",processedAt:null,content:[]},4);
 await f.sql.exec("UPDATE managed_sessions SET revision=4");
 const queued = await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='next'").first<{document:string}>();
 const result = await f.app.finalize({...request,revision:4});
 expect(result).toMatchObject({type:"committed",terminal:{turnId:"input"}});
 expect(await f.sql.prepare("SELECT state,claim_generation,claim_worker_id FROM managed_environment_work").first())
  .toEqual({state:"active",claim_generation:2,claim_worker_id:"worker"});
 expect(await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='next'").first()).toEqual(queued);
 expect(await f.app.recover({claim,turnId:"next"})).toMatchObject({type:"run",turnId:"next"});
 if(result.type!=="committed")throw Error("missing terminal");
 expect(await f.app.publish({claim,turnId:"input",revision:result.revision,terminalEventId:result.terminal.eventId}))
  .toMatchObject({type:"published"});
 expect(await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='next'").first()).toEqual(queued);
});
it("does not finalize an older turn over a successor that has already begun execution", async () => {
 const f=await fixture();
 await f.insert({id:"next",type:"user.message",processedAt:now,content:[]},4,{consumed_by_execution_id:"next"});
 await f.sql.exec("UPDATE managed_sessions SET revision=4");
 expect(await f.app.finalize({...request,revision:4})).toMatchObject({type:"rejected",reason:"newer_input"});
 expect(await events(f.sql)).toEqual([]);
 expect(f.trace).toEqual([]);
});

it("commits the first custom pause from canonical calls without granting resume or end_turn",async()=>{
 const f=await fixture();
 const root=await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='input'").first<{document:string}>();
 const doc=JSON.parse(root!.document);doc.source_position.consumption_claim={workId:"w",generation:2,holder:"worker"};
 await f.sql.prepare("UPDATE managed_session_events SET document=? WHERE id='input'").bind(JSON.stringify(doc)).run();
 await f.insert({id:"custom",type:"agent.custom_tool_use",name:"approve",input:{},processedAt:now},3,{execution_id:"input",environment_work:{workId:"w",generation:2}});
 expect(await f.app.recover({claim,turnId:"input"})).toMatchObject({type:"gap",reason:"consumed_turn_without_terminal",revision:3});
 expect(await f.app.checkpoint(request)).toMatchObject({type:"prepared"});
 expect(await f.app.finalize(request)).toMatchObject({type:"parked",terminal:{stopReason:{type:"requires_action",eventIds:["custom"]}}});
 expect((await events(f.sql)).map(e=>e.stopReason)).toEqual([{type:"requires_action",eventIds:["custom"]}]);
 // A runtime running label is not a consumed answer and must not reopen the
 // paused turn. Claim and revision remain otherwise valid.
 await f.insert({id:"unsafe-resume",type:"session.status_running",processedAt:now},5,{execution_id:"input",environment_work:{workId:"w",generation:2}});
 await f.sql.exec("UPDATE managed_sessions SET revision=5");
 expect(await f.app.recover({claim,turnId:"input"})).toMatchObject({type:"gap",reason:"requires_action_pending"});
 expect(await f.app.finalize({...request,revision:5})).toMatchObject({type:"gap",reason:"requires_action_pending"});
 expect((await events(f.sql)).length).toBe(1);
});
