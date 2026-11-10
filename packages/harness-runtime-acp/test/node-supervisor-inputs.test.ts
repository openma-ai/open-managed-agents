import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { serve } = createRequire(new URL("../../../apps/main-node/package.json", import.meta.url).href)("@hono/node-server") as typeof import("../../../apps/main-node/node_modules/@hono/node-server");

import { loadNodeConfig } from "../../../apps/main-node/src/config.js";
import { nodeDefaults } from "../../../apps/main-node/src/components.js";
import { createNodeControlPlane } from "../../../apps/main-node/src/control-plane.js";
import { WorkFinalizationApplication } from "../../managed-agents-application/src/work-finalization/application.js";
import { SessionRuntimeProjectionApplicationService } from "../../managed-agents-application/src/session-execution/application.js";
import { SqlSessionRuntimeProjectionPersistence } from "../../managed-agents-adapters-sql/src/session-runtime-projection-sql-persistence.js";
import type { SqlClient } from "../../sql-client/src/index.js";
import { SqlWorkFinalization } from "../../managed-agents-adapters-sql/src/work-finalization.js";
import { buildWorkFinalizationRoutes } from "../../http-routes/src/work-finalization.js";
import { authenticateWorkFinalizationBearer } from "../../managed-agents-adapters-runtime/src/environment-work-session-token.js";
import { SqlEnvironmentWorkStore } from "../../environment-work-store-sql/src/index.js";
import { createNodeManagedAcpSupervisorApp } from "../src/node-supervisor.js";
import type { WorkControlRuntime } from "../src/work-control-runtime.js";

// Candidate SOURCE composition only; no package alias/install/lock mutation.
// Explicit env makes this suite opt-in, rather than pretending 0.13.1 has hooks.
const candidate = process.env.OPENMA_COMMON_CANDIDATE;
const cleanup: Array<()=>Promise<unknown>>=[];
afterEach(async()=>{ for(const close of cleanup.splice(0).reverse()) await close(); });
const deferred = () => {let resolve!:()=>void; const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function fixture(scenario:"prompt"|"approval"|"resume"|"steer"|"interrupt"|"lost"|"mode-failed"|"bad-output-ack"|"claim-lost"|"outcome"|"root-proof", failStartup = false) {
 const runtimePath=candidate+"/src/managed-runtime/index.ts";
 const modePath=candidate+"/src/acp-runtime/permission-mapping.ts";
 const common=await import(/* @vite-ignore */ runtimePath);
 const { AcpRuntimeImpl } = await import(/* @vite-ignore */ candidate+"/src/acp-runtime/runtime.ts");
 const modes=await import(/* @vite-ignore */ modePath);
 const runtime:WorkControlRuntime={createSupervisor:common.createManagedAcpSupervisorHarness,createControlChannel:common.createManagedHarnessHttpControlChannel,applyPermissionMode:modes.applyAcpPermissionMode};
 const root=await mkdtemp(join(tmpdir(),"supervisor-inputs-"));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const config=loadNodeConfig({NODE_ENV:"test",AUTH_DISABLED:"0",API_KEY:"test-admin",PROCESS_MODE:"api",LOG_LEVEL:"silent",PLATFORM_ROOT_SECRET:"test-work-inputs-root-secret-32-characters",OPENMA_TEST_SANDBOX_PROVIDER:"local-subprocess",DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),MEMORY_BLOB_DIR:join(root,"memory"),SESSION_OUTPUTS_DIR:join(root,"outputs"),SANDBOX_WORKDIR:join(root,"sandbox"),MEMORY_QUEUE:"disabled"});
 const components=await nodeDefaults(config);const cp=await createNodeControlPlane(components);cleanup.push(()=>cp.stop("test"));
 let finalRoutes: ReturnType<typeof buildWorkFinalizationRoutes> | undefined;
 const server=serve({fetch:request => {
  const url=new URL(request.url);
  if(finalRoutes&&url.pathname.includes("/work-")){url.pathname=url.pathname.replace("/v1/oma/sessions","");return finalRoutes.fetch(new Request(url,request));}
  return cp.fetch(request);
 },hostname:"127.0.0.1",port:0});cleanup.push(()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
 if(!server.listening)await new Promise<void>(resolve=>server.once("listening",resolve));
 const address=server.address();if(!address||typeof address==="string")throw new Error("No HTTP address");
 const base="http://127.0.0.1:"+address.port;
 async function create(path:string,body:unknown):Promise<Record<string,unknown>>{const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json","x-api-key":"test-admin"},body:JSON.stringify(body)});expect(r.status,await r.clone().text()).toBeLessThan(300);return await r.json() as Record<string,unknown>;}
 const env=await create("/v1/environments",{name:"inputs",config:{type:"cloud",networking:{type:"unrestricted"}}});
 const agent=await create("/v1/agents",{name:"inputs",model:"test",_oma:{harness:"acp-sandbox",acp:{agent:{registry:"claude-acp@0.94.0"}}}});
 const session=await create("/v1/sessions",{agent:agent.id,environment_id:env.id,initial_events:[{type:"user.message",content:[{type:"text",text:"first"}]}]});
 const sql=components.database.sql;
 const scope={workspaceId:"default",environmentId:String(env.id),sessionId:String(session.id),workId:"supervisor-work"};
 const order:string[]=[];const notifications:Array<{phase:string;turnId:string}>=[];
 const cipher=components.secrets!.cipherFor("managed.environment-work.secret");
 const store=new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})});
 const now=new Date().toISOString();
 const token="sk-ant-req-v1."+await components.secrets!.cipherFor("managed.environment-work.session-token").encrypt(JSON.stringify({version:1,...scope,issuedAt:now,expiresAt:new Date(Date.now()+60000).toISOString(),claimedAt:now,generation:2,skills:[],files:[],memoryStores:[]}));
 await sql.prepare("DELETE FROM managed_environment_work WHERE session_id=?").bind(session.id).run();
 await store.insert({workspaceId:"default",record:{work:{id:scope.workId,environmentId:scope.environmentId,data:{type:"session",id:scope.sessionId},state:"active",createdAt:now,acknowledgedAt:now,latestHeartbeatAt:now,startedAt:now,metadata:{},stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:token},claim:{generation:2,workerId:"supervisor-holder",claimedAt:now},heartbeatTtlSeconds:90}});
 if(scenario==="root-proof") {
  const path=base+"/v1/oma/sessions/"+session.id;
  const post=async(action:string,body:unknown)=>fetch(path+"/"+action,{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body)});
  const first=await (await post("inputs-read",{cursor:null,limit:1})).json() as {rows:Array<{event:{id:string};document:string}>};
  const rootId=first.rows[0]!.event.id;
  expect((await post("inputs-consume",{inputId:rootId,turnId:rootId,expectedDocument:first.rows[0]!.document,boundary:"before_dispatch"})).status).toBe(200);
  const consumed=await (await post("inputs-read",{cursor:null,limit:1})).json() as typeof first;
  const root={inputId:rootId,turnId:rootId,expectedDocument:consumed.rows[0]!.document};
  const events=[{id:"root-tool",type:"agent.tool_use",name:"Read",input:{path:"a"},evaluated_permission:"ask",processed_at:now}];
  const result=await post("runtime-events",{events,root});
  expect(result.status,await result.clone().text()).toBe(200);
  const stored=await sql.prepare("SELECT document FROM managed_session_events WHERE id='root-tool'").first<{document:string}>();
  expect(JSON.parse(stored!.document).source_position).toMatchObject({execution_id:rootId,environment_work:{workId:scope.workId,generation:2}});
  for(const [index,proof] of [{...root,turnId:"forged"},{...root,expectedDocument:first.rows[0]!.document},{...root,inputId:"fake"}].entries()){
   expect((await post("runtime-events",{events:[{...events[0],id:"rejected-"+index}],root:proof})).status).toBeGreaterThanOrEqual(400);
  }
  expect((await post("runtime-events",{events,root})).status).toBe(409); // no blind receipt replay
  for(const [id,mutation,restore] of [
   ["ttl","claim_at=0",`claim_at=${Date.parse(now)}`],
   ["generation","claim_generation=3","claim_generation=2"],
   ["stopped","state='stopped'","state='active'"],
  ]) {
   await sql.prepare("UPDATE managed_environment_work SET "+mutation+" WHERE id=?").bind(scope.workId).run();
   expect((await post("runtime-events",{events:[{...events[0],id}],root})).status).toBeGreaterThanOrEqual(400);
   await sql.prepare("UPDATE managed_environment_work SET "+restore+" WHERE id=?").bind(scope.workId).run();
  }
  // Root raw-CAS and captured Session revision must survive races after proof
  // reads, at the actual transaction boundary. Use real SQL with one IO hook.
  for(const race of ["root-bytes","revision"] as const) {
   const original=await sql.prepare("SELECT revision FROM managed_sessions WHERE id=?").bind(session.id).first<{revision:number}>();
   const mutate=async()=>{if(race==="revision")await sql.prepare("UPDATE managed_sessions SET revision=revision+1 WHERE id=?").bind(session.id).run();
    else await sql.prepare("UPDATE managed_session_initial_events SET document=? WHERE session_id=? AND sequence=0").bind(root.expectedDocument+" ",session.id).run();};
   const raced:SqlClient={prepare:q=>sql.prepare(q),exec:q=>sql.exec(q),batch:async statements=>{await mutate();return sql.batch(statements);},
    ...(sql.batchChecked?{batchChecked:async(statements,validate)=>{await mutate();return sql.batchChecked!(statements,validate);}}:{})};
   const application=new SessionRuntimeProjectionApplicationService({workspaceId:"default",persistence:new SqlSessionRuntimeProjectionPersistence(raced)});
   const result=await application.recordSessionRuntimeEvents({sessionId:String(session.id),environmentWorkFence:{...scope,generation:2},workRoot:root,workRootDialect:"sqlite",
    events:[{id:race,type:"agent.tool_use",name:"Read",input:{path:"a"},evaluatedPermission:"ask",processedAt:now}]});
   expect(result.type).not.toBe("recorded");expect(await sql.prepare("SELECT id FROM managed_session_events WHERE id=?").bind(race).first()).toBeNull();
   await sql.prepare("UPDATE managed_session_initial_events SET document=? WHERE session_id=? AND sequence=0").bind(root.expectedDocument,session.id).run();
   await sql.prepare("UPDATE managed_sessions SET revision=? WHERE id=?").bind(original!.revision,session.id).run();
  }
  expect((await post("runtime-events",{root,events:[{id:"forged-pause",type:"session.status_idle",stop_reason:{type:"requires_action",event_ids:["unrelated"]},processed_at:now}]})).status).toBe(409);
  // A result cannot borrow an unrelated tool identity, even with a valid root.
  expect((await post("runtime-events",{root,events:[{id:"forged-tool-result",type:"agent.tool_result",tool_use_id:"unrelated",content:[],processed_at:now}]})).status).toBe(409);
  await sql.prepare("UPDATE managed_environment_work SET claim_worker_id='new-holder' WHERE id=?").bind(scope.workId).run();
  expect((await post("runtime-events",{events:[{...events[0],id:"old-holder"}],root})).status).toBeGreaterThanOrEqual(400);
  expect(await sql.prepare("SELECT id FROM managed_session_events WHERE id='old-holder'").first()).toBeNull();
  await sql.prepare("UPDATE managed_environment_work SET claim_worker_id='supervisor-holder' WHERE id=?").bind(scope.workId).run();
  const current=await sql.prepare("SELECT revision FROM managed_sessions WHERE id=?").bind(session.id).first<{revision:number}>();
  await sql.prepare("INSERT INTO managed_session_events(workspace_id,session_id,id,type,document,processed_at) VALUES('default',?,'closed-root','session.status_idle',?,?)").bind(session.id,JSON.stringify({id:"closed-root",type:"session.status_idle",processedAt:now,stopReason:{type:"end_turn"},source_position:{revision:current!.revision+1,index:0,execution_id:rootId,environment_work:{workId:scope.workId,generation:2}}}),Date.now()).run();
  await sql.prepare("UPDATE managed_sessions SET revision=revision+1 WHERE id=?").bind(session.id).run();
  expect((await post("runtime-events",{events:[{...events[0],id:"after-terminal"}],root})).status).toBe(409);
  throw new Error("root-proof-verified");
 }
 // Real routes/auth/SQL; physical storage/artifact ports are controlled fixtures, NOT provider certification.
 finalRoutes=buildWorkFinalizationRoutes({
  authenticate:(token,method,path)=>authenticateWorkFinalizationBearer({token,method,path,crypto:components.secrets!.cipherFor("managed.environment-work.session-token"),now:()=>new Date(),find:claim=>store.find({workspaceId:claim.workspaceId,environmentId:claim.environmentId,workId:claim.workId})}),
  applicationFor:async()=>new WorkFinalizationApplication({persistence:new SqlWorkFinalization(sql),host:{
   async prepare(scope){if(!await scope.isCurrent())throw new Error("Lost authority");order.push("canonical");return {type:"prepared"};},
   async publish(scope){if(!await scope.isCurrent())throw new Error("Lost authority");order.push("post");return {type:"published"};},
  }}),
 });
 let revision=3;
 async function append(event:Record<string,unknown>){const current=await sql.prepare("SELECT revision FROM managed_sessions WHERE id=?").bind(session.id).first<{revision:number}>();revision=Math.max(revision,current!.revision+1);const document=JSON.stringify({...event,source_position:{revision:revision++,index:0,execution_id:"dispatch-"+event.id}});await sql.prepare("INSERT INTO managed_session_events(workspace_id,session_id,id,type,document,processed_at) VALUES(?,?,?,?,?,?)").bind("default",session.id,event.id,event.type,document,Date.now()).run();await sql.prepare("UPDATE managed_sessions SET revision=MAX(revision,?) WHERE id=?").bind(revision-1,session.id).run();}
 if(scenario==="outcome") {
  await sql.prepare("DELETE FROM managed_session_initial_events WHERE session_id=?").bind(session.id).run();
  await append({id:"outcome",type:"user.define_outcome",description:"test outcome",rubric:{type:"text",content:"must evaluate"},processedAt:now});
 }
 if(scenario==="resume"){
  const initial=await sql.prepare("SELECT document FROM managed_session_initial_events WHERE session_id=?").bind(session.id).first<{document:string}>();
  const raw=JSON.parse(initial!.document);raw.processedAt=now;raw.source_position.consumed_by_execution_id=raw.id;
  await sql.prepare("UPDATE managed_session_initial_events SET document=? WHERE session_id=?").bind(JSON.stringify(raw),session.id).run();
  await append({id:"idle",type:"session.status_idle",stopReason:{type:"budget_reached"},processedAt:now});
  await append({id:"resume",type:"session.updated",resume:true,processedAt:now});
 }
 const prompts:string[]=[];const wire:Record<string,unknown>[]=[];const done=deferred();
 let send!:(value:object)=>void;let promptId:unknown;let buffer="";const exit=deferred();
 let configOptions=[{id:"mode",name:"Mode",category:"mode",type:"select",currentValue:"default",options:[{value:"default",name:"Default"},{value:"auto",name:"Auto"},{value:"bypassPermissions",name:"Bypass"}]}];
 const acpRuntime=new AcpRuntimeImpl({async spawn(){return {
  stdout:new ReadableStream<Uint8Array>({start(c){send=value=>c.enqueue(new TextEncoder().encode(JSON.stringify({jsonrpc:"2.0",...value})+"\n"));}}),
  stderr:new ReadableStream<Uint8Array>({start(c){c.close();}}),
  stdin:new WritableStream<Uint8Array>({async write(bytes){buffer+=new TextDecoder().decode(bytes);while(buffer.includes("\n")){const end=buffer.indexOf("\n");const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);wire.push(m);
   if(m.method==="initialize")send({id:m.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:"@agentclientprotocol/claude-agent-acp",version:"0.75.1"}}});
   else if(m.method==="session/new")send({id:m.id,result:{sessionId:"native",configOptions}});
   else if(m.method==="session/set_config_option"){order.push("mode");configOptions=configOptions.map(o=>({...o,currentValue:scenario==="mode-failed"?"auto":m.params.value}));send({id:m.id,result:{configOptions}});}
   else if(m.method==="session/prompt"){
    order.push("prompt");promptId=m.id;prompts.push(m.params.prompt.map((b:{text?:string})=>b.text??"").join(""));
    if(scenario==="approval"){
     send({method:"session/update",params:{sessionId:"native",update:{sessionUpdate:"tool_call",toolCallId:"native-tool",title:"Read",kind:"read",status:"pending",rawInput:{path:"a"}}}});
     send({id:"original-callback",method:"session/request_permission",params:{sessionId:"native",toolCall:{toolCallId:"native-tool",title:"Read",kind:"read",rawInput:{path:"a"}},options:[{optionId:"yes",kind:"allow_once",name:"Allow"},{optionId:"no",kind:"reject_once",name:"Deny"}]}});
    }else if((scenario==="steer"||scenario==="interrupt")&&prompts.length===1){
     if(scenario==="interrupt")await append({id:"interrupt",type:"user.interrupt",processedAt:now});
     await append({id:"next",type:"user.message",processedAt:null,content:[{type:"text",text:"second"}]});
     if(scenario==="steer")send({id:m.id,result:{stopReason:"end_turn"}});
    }else send({id:m.id,result:{stopReason:"end_turn"}});
   }else if(m.method==="session/cancel")send({id:promptId,result:{stopReason:"cancelled"}});
   else if(m.id==="original-callback"&&m.result){order.push("callback");send({method:"session/update",params:{sessionId:"native",update:{sessionUpdate:"tool_call_update",toolCallId:"native-tool",status:"completed",rawOutput:"read result"}}});send({id:promptId,result:{stopReason:"end_turn"}});}
  }}}),async kill(){exit.resolve();},exited:exit.promise.then(()=>({code:0,signal:null})),
 };}});
 let consumeCount=0;let publishedTurns=0;let publicPolls=0;const cursors:unknown[]=[];const rootReads:Array<{cursor:unknown;limit:number}>=[];let awaitingRootRead=false;const outputs:Record<string,unknown>[]=[];
 const fetcher:typeof fetch=async(raw,init)=>{
  const url=String(raw);if(url.includes("/events?"))publicPolls++;
  if(url.endsWith("/inputs-read")){
   const request=JSON.parse(String(init?.body));
   if(awaitingRootRead){rootReads.push(request);awaitingRootRead=false;}else cursors.push(request.cursor);
  }
  if(url.endsWith("/inputs-consume")){if(scenario==="claim-lost")await sql.prepare("UPDATE managed_environment_work SET claim_generation=3 WHERE id=?").bind(scope.workId).run();consumeCount++;order.push("consume");const r=await fetch(raw,init);if(scenario==="lost")throw new Error("lost response");if(r.ok && !JSON.parse(String(init?.body)).consumingTurnId)awaitingRootRead=true;return r;}
  const r=await fetch(raw,init);
  if(url.includes("/work-")&&!r.ok)console.error("FINALIZATION HTTP",scenario,await r.clone().text());
  if(scenario==="bad-output-ack"&&url.endsWith("/runtime-events"))return Response.json({queued:true});
  if(url.endsWith("/work-finalize")&&r.ok) order.push("terminal");
  if(url.endsWith("/work-publish")&&r.ok){
   publishedTurns++;
   // A resident worker publishes each turn independently. For a queued
   // successor, the first receipt is not completion of the two-turn scenario.
   if(publishedTurns >= (scenario==="steer" ? 2 : 1)) done.resolve();
  }
  if(url.endsWith("/runtime-events")){
   const events:Record<string,unknown>[]=JSON.parse(String(init?.body)).events;outputs.push(...events);
   for(const event of events){
    if(event.type==="agent.tool_use"&&event.evaluated_permission==="ask")await append({id:"confirmation",type:"user.tool_confirmation",toolUseId:event.id,result:"allow",processedAt:null});
    if(event.type==="session.status_idle"&&(event.stop_reason as {type:string}).type==="end_turn"){order.push("terminal");}
   }
  }
  return r;
 };
 const app=createNodeManagedAcpSupervisorApp({
  ...{onTurnAdmitted:(turnId:string)=>{notifications.push({phase:"admitted",turnId});order.push("admitted");},
    onTurnPublished:(turnId:string)=>{notifications.push({phase:"published",turnId});order.push("published");}},
  environment:{ANTHROPIC_ENVIRONMENT_ID:scope.environmentId,ANTHROPIC_SESSION_ID:scope.sessionId,ANTHROPIC_WORK_ID:scope.workId,ANTHROPIC_WORK_SECRET:Buffer.from(JSON.stringify({sessions_token:token,api_base_url:base})).toString("base64url")},agentId:"claude-acp",workClaim:{generation:2,holder:"supervisor-holder"},control:{runtime,pollIntervalMs:2,retry:{maxAttempts:1}},fetch:fetcher,acpRuntime:failStartup ? {start:async()=>{throw new Error("fixture spawn failure");}} : acpRuntime,
  finalization:{async drainTurn(context){await context.flush();order.push("drain");}},
  stateIo:{async readFile(){throw Object.assign(new Error("missing"),{code:"ENOENT"});},async writeFile(path,content){if(path.includes("checkpoint")&&content.includes("last_completed_turn_id"))order.push("native");},async writeFileBytes(){},async exec(){return "";}},lifecycle:{drainDeadlineMs:0,abortGraceMs:0,startupRetry:{attempts:1,delayMs:()=>0}},
 });
 const harness=(await app.resolveHarness({id:"acp",version:"1"}))!;
 const run=await harness.start({scope,harness:{id:"acp",version:"1"},workspacePath:"/workspace",outputPath:null,checkpoint:async()=>{order.push("canonical");},signal:new AbortController().signal});
 const completion=run.completed.catch(error=>{console.error("INTEGRATION FAILURE",scenario,error);done.resolve();return error;});
 cleanup.push(()=>run.stop("aborted"));
 await Promise.race([done.promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error("supervisor did not settle")),5000);timer.unref();})]);
 return {notifications,prompts,wire,order,consumeCount,publicPolls,cursors,rootReads,outputs,completion,sql,session,run};
}
it.skipIf(!candidate).each(["prompt","resume","approval","steer","interrupt"] as const)("private Node HTTP/SQLite -> supervisor: %s",async scenario=>{
 const f=await fixture(scenario);
 expect(f.prompts).toEqual(scenario==="resume"?[""]:scenario==="steer"||scenario==="interrupt"?["first","second"]:["first"]);
 expect(f.order.indexOf("drain")).toBeLessThan(f.order.indexOf("canonical"));expect(f.order.indexOf("canonical")).toBeLessThan(f.order.indexOf("terminal"));expect(f.order.indexOf("terminal")).toBeLessThan(f.order.lastIndexOf("post"));
 expect(f.publicPolls).toBe(0);expect(f.cursors.length).toBeGreaterThan(0);expect(f.cursors.slice(1).every(c=>c!==null)).toBe(true);
 expect(f.rootReads).toHaveLength(f.prompts.length);expect(f.rootReads.every(read=>read.limit>=1&&read.limit<=100)).toBe(true);
 expect(f.order.indexOf("mode")).toBeLessThan(f.order.indexOf("consume"));expect(f.order.indexOf("consume")).toBeLessThan(f.order.indexOf("prompt"));
 if(scenario==="approval"){
  expect(f.wire.filter(m=>m.id==="original-callback")).toEqual([{jsonrpc:"2.0",id:"original-callback",result:{outcome:{outcome:"selected",optionId:"yes"}}}]);
  const tools=f.outputs.filter(e=>e.type==="agent.tool_use");expect(tools).toHaveLength(1);expect(tools[0]?.evaluated_permission).toBe("ask");
  expect(f.outputs.find(e=>e.type==="agent.tool_result")?.tool_use_id).toBe(tools[0]?.id);
  expect(f.consumeCount).toBe(2);
 }
});
it.skipIf(!candidate).each(["lost","mode-failed"] as const)("does not dispatch or blindly retry on %s",async scenario=>{
 const f=await fixture(scenario);expect(f.prompts).toEqual([]);expect(f.consumeCount).toBe(scenario==="lost"?1:0);expect(await f.completion).toBeInstanceOf(Error);
});

it.skipIf(!candidate)("rejects HTTP enqueue acknowledgement instead of claiming durable terminal",async()=>{
 const f=await fixture("bad-output-ack");expect(await f.completion).toBeInstanceOf(Error);expect(f.order).not.toContain("post");
});

it("does not silently use installed common when dispatch capability is missing",async()=>{
 const app=createNodeManagedAcpSupervisorApp({agentId:"claude-acp",finalization:{drainTurn:async()=>{throw new Error("must not run");}}});
 await expect(app.resolveHarness({id:"acp",version:"1"})).rejects.toThrow("common capability injection required");
});

it.skipIf(!candidate).each(["claim-lost","outcome"] as const)("fails closed before sampling on %s",async scenario=>{
 const f=await fixture(scenario);expect(f.prompts).toEqual([]);expect(await f.completion).toBeInstanceOf(Error);expect(f.consumeCount).toBe(scenario==="claim-lost"?1:0);
});

it.skipIf(!candidate)("authenticates consumed root bytes through real Node HTTP and SQLite projection",async()=>{
 await expect(fixture("root-proof")).rejects.toThrow("root-proof-verified");
});

it.skipIf(!candidate)("notifies runner only after canonical input and publication acknowledgements",async()=>{
 const f=await fixture("prompt");
 await expect.poll(()=>f.notifications.length).toBe(2);
 expect(f.notifications[0]).toMatchObject({phase:"admitted"});
 expect(f.notifications[1]).toEqual({phase:"published",turnId:f.notifications[0]!.turnId});
 expect(f.order.indexOf("consume")).toBeLessThan(f.order.indexOf("admitted"));
 expect(f.order.indexOf("admitted")).toBeLessThan(f.order.indexOf("prompt"));
 expect(f.order.lastIndexOf("post")).toBeLessThan(f.order.indexOf("published"));
});

it.skipIf(!candidate)("marks asynchronous spawn exhaustion as startup rather than run failure",async()=>{
 const f=await fixture("prompt",true);
 expect(await f.completion).toMatchObject({name:"NodeManagedAcpWorkItemFailure",phase:"startup"});
 expect(f.prompts).toEqual([]);
 expect(f.notifications).toEqual([]);
});
