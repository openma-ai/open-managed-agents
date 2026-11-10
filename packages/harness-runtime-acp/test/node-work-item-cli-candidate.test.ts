import { workRuntimeModules } from "./helpers/work-runtime-modules.js";
import {expect,it} from "vitest";
import {mkdtemp,rm,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {createSqlEnvironmentWorkSandboxTokenStore,environmentWorkSandboxTokenRef} from "../../sandbox-gateway-sql/src/index.js";
import {issueSandboxToken} from "../../sandbox-gateway/src/index.js";
import {NodeSpawner} from "@open-managed-agents/acp-runtime/node-spawner";
import type {AgentSpec} from "@open-managed-agents/acp-runtime";
import {WorkTurnActivities} from "../src/node-work-composition.js";
import {runNodeWorkItemCli} from "../src/node-work-item-cli.js";
import {loadNodeConfig} from "../../../apps/main-node/src/config.js";
import {nodeDefaults} from "../../../apps/main-node/src/components.js";
import {createNodeControlPlane} from "../../../apps/main-node/src/control-plane.js";
import {WorkFinalizationApplication} from "../../managed-agents-application/src/work-finalization/application.js";
import {SqlWorkFinalization} from "../../managed-agents-adapters-sql/src/work-finalization.js";
import {buildWorkFinalizationRoutes} from "../../http-routes/src/work-finalization.js";
import {authenticateWorkFinalizationBearer} from "../../managed-agents-adapters-runtime/src/environment-work-session-token.js";
import {SqlEnvironmentWorkStore} from "../../environment-work-store-sql/src/index.js";
const {getRequestListener}=createRequire(new URL("../../../apps/main-node/package.json",import.meta.url).href)("@hono/node-server") as typeof import("../../../apps/main-node/node_modules/@hono/node-server");

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
it.each(["joined", "pending", "sync", "sync-claude", "sync-command", "sync-agent", "detached", "outcome-satisfied", "outcome-post", "outcome-interrupt", "outcome-max", "outcome-failed", "outcome-abort", "outcome-budget", "outcome-script"] as const)("default CLI composition bootstraps from Node HTTP/SQLite then joins a registered child before publication (mode=%s)",async(mode)=>{
 const { common, modes, AcpRuntimeImpl } = await workRuntimeModules();
 const outcomeMode = mode.startsWith("outcome-");
 let grades = 0;
 let interrupt: (()=>Promise<void>) | undefined;
 const canonicalInterrupt=deferred();
 let interruptReceipt: Record<string,unknown> | undefined;
 const outcomeSpans: any[] = [];
 const cleanup:Array<()=>Promise<unknown>>=[];
 const root=await mkdtemp(join(tmpdir(),"work-cli-candidate-"));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 try {
 let prompts=0; const controller=new AbortController();
 const provider=createServer(async(req,res)=>{
   let raw="";for await(const bytes of req)raw+=bytes;
   const body=JSON.parse(raw || "{}");
   const judging=body.messages?.some((m:any)=>typeof m.content === "string" && m.content.includes("## Rubric"));
   if(judging){expect(JSON.stringify(body.messages)).toContain(prompts>1?"hello":"draft");grades++;}
   if(judging&&mode === "outcome-interrupt") { await interrupt!(); return; }
   if(judging&&mode === "outcome-abort") { controller.abort(new DOMException("test abort","AbortError"));res.statusCode=499;res.end("cancelled");return; }
   res.setHeader("content-type","application/json");res.end(JSON.stringify({id:"chatcmpl-fixture",object:"chat.completion",created:1,model:"judge",choices:[{index:0,message:{role:"assistant",content:JSON.stringify({result:(mode === "outcome-satisfied" || mode === "outcome-post") && grades>1?"satisfied":"needs_revision",explanation:"write hello"})},finish_reason:"stop"}],usage:{prompt_tokens:11,completion_tokens:3}}));
 });
 if(outcomeMode){await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));cleanup.push(()=>new Promise<void>(resolve=>{provider.closeAllConnections();provider.close(()=>resolve());}));}
 const controlServer=createServer(); await new Promise<void>(resolve=>controlServer.listen(0,"127.0.0.1",resolve));
 const base="http://127.0.0.1:"+(controlServer.address() as {port:number}).port;
 cleanup.push(()=>new Promise<void>(resolve=>{controlServer.closeAllConnections();controlServer.close(()=>resolve());}));
 const config=loadNodeConfig({PUBLIC_BASE_URL:base,GATEWAY_ORIGIN:base,NODE_ENV:"test",AUTH_DISABLED:"0",API_KEY:"test-admin",PROCESS_MODE:"api",LOG_LEVEL:"silent",PLATFORM_ROOT_SECRET:"test-work-inputs-root-secret-32-characters",OPENMA_TEST_SANDBOX_PROVIDER:"local-subprocess",DATABASE_PATH:join(root,"db.sqlite"),AUTH_DATABASE_PATH:join(root,"auth.sqlite"),MEMORY_BLOB_DIR:join(root,"memory"),SESSION_OUTPUTS_DIR:join(root,"outputs"),SANDBOX_WORKDIR:join(root,"sandbox"),MEMORY_QUEUE:"disabled"});
 const components=await nodeDefaults(config);const cp=await createNodeControlPlane(components);cleanup.push(()=>cp.stop("test"));
 let finalRoutes: ReturnType<typeof buildWorkFinalizationRoutes> | undefined;
 controlServer.on("request",getRequestListener(request => {
  const url=new URL(request.url);
  if(finalRoutes&&["work-checkpoint","work-finalize","work-publish","work-failed"].some(action=>url.pathname.endsWith("/"+action))){url.pathname=url.pathname.replace("/v1/oma/sessions","");return finalRoutes.fetch(new Request(url,request));}
  return cp.fetch(request);
 }));
 async function create(path:string,body:unknown):Promise<Record<string,unknown>>{const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json","x-api-key":"test-admin"},body:JSON.stringify(body)});expect(r.status,await r.clone().text()).toBeLessThan(300);return await r.json() as Record<string,unknown>;}
 if(outcomeMode) await create("/v1/oma/model_cards",{model_id:"test",model:"judge",provider:"openai",base_url:"http://127.0.0.1:"+(provider.address() as {port:number}).port,api_key:"fixture-not-a-real-key",pricing:{version:1,currency:"USD",input_per_mtok:mode === "outcome-budget" ? "10000" : "1",output_per_mtok:"1"}});
 const env=await create("/v1/environments",{name:"inputs",config:{type:"cloud",networking:{type:"unrestricted"}}});
 const agent=await create("/v1/agents",{name:"inputs",model:"test",_oma:{harness:"acp-sandbox",acp:{agent:{registry:"claude-acp@0.94.0"}}}});
 const session=await create("/v1/sessions",{...(mode === "outcome-budget" ? {budget:{type:"limit",max_list_cost:{amount:"1",currency:"USD"}}} : {}),agent:agent.id,environment_id:env.id,initial_events:(mode === "outcome-post" || mode === "outcome-interrupt") ? [] : outcomeMode ? [{type:"user.define_outcome",description:"write hello",rubric:{type:"text",content:mode === "outcome-failed" ? "" : "must say hello"},max_iterations:2}] : [{type:"user.message",content:[{type:"text",text:"first"}]}]});
 // Public verifier is a new API, not part of the existing rubric contract.
 // Keep an actual HTTP negative case; internal rule executor coverage lives
 // in node-work-verifier.test.ts and node-work-outcomes.test.ts.
 if(mode === "outcome-script") {
   const response=await cp.fetch(new Request(base+`/v1/sessions/${session.id}/events`,{
     method:"POST",headers:{"x-api-key":"test-admin","content-type":"application/json"},
     body:JSON.stringify({events:[{type:"user.define_outcome",description:"proof",rubric:{type:"text",content:"exists"},_oma:{verifier:{type:"script",verify_script:"test -f proof"}}}]}),
   }));
   expect(response.status).toBe(400); expect(prompts).toBe(0); expect(grades).toBe(0); return;
 }
 if(mode === "outcome-post" || mode === "outcome-interrupt") await create(`/v1/sessions/${session.id}/events`,{events:[{type:"user.define_outcome",description:"write hello",rubric:{type:"text",content:"must say hello"},max_iterations:2}]});
 interrupt=async()=>{
   const send=()=>fetch(base+`/v1/sessions/${session.id}/events`,{method:"POST",headers:{"content-type":"application/json","x-api-key":"test-admin","Idempotency-Key":"outcome-interrupt-once"},body:JSON.stringify({events:[{type:"user.interrupt"}]})});
   const first=await send();expect(first.status).toBe(200);interruptReceipt=await first.json() as Record<string,unknown>;
   const replay=await send();expect(replay.status).toBe(200);expect(await replay.json()).toEqual(interruptReceipt);
   canonicalInterrupt.resolve();
 };
 const sql=components.database.sql;
 const scope={workspaceId:"default",environmentId:String(env.id),sessionId:String(session.id),workId:"supervisor-work"};
 const order:string[]=[];
 const cipher=components.secrets!.cipherFor("managed.environment-work.secret");
 const store=new SqlEnvironmentWorkStore(sql,{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})});
 const now=new Date().toISOString();
 const token="sk-ant-req-v1."+await components.secrets!.cipherFor("managed.environment-work.session-token").encrypt(JSON.stringify({version:1,...scope,issuedAt:now,expiresAt:new Date(Date.now()+60000).toISOString(),claimedAt:now,generation:2,skills:[],files:[],memoryStores:[]}));
 await sql.prepare("DELETE FROM managed_environment_work WHERE session_id=?").bind(session.id).run();
 await store.insert({workspaceId:"default",record:{work:{id:scope.workId,environmentId:scope.environmentId,data:{type:"session",id:scope.sessionId},state:"queued",createdAt:now,acknowledgedAt:null,latestHeartbeatAt:null,startedAt:null,metadata:{},stopRequestedAt:null,stoppedAt:null},secret:{sessionsToken:token},claim:{generation:2,workerId:"supervisor-holder",claimedAt:now},heartbeatTtlSeconds:90}});

 const activity=deferred(),draining=deferred(),published=deferred(),exit=deferred();
 let send!:(value:object)=>void,buffer="";
 let configOptions=[{id:"mode",name:"Mode",category:"mode",type:"select",currentValue:"read-only",options:[{value:"read-only",name:"Read only"},{value:"agent",name:"Agent"},{value:"agent-full-access",name:"Full"}]}];
 if((mode === "sync-claude" || mode === "sync-agent")) configOptions=[{id:"mode",name:"Mode",category:"mode",type:"select",currentValue:"default",options:[{value:"default",name:"Default"},{value:"auto",name:"Auto"},{value:"bypassPermissions",name:"Bypass"}]}];
 const activities = new WorkTurnActivities();
 const spawner={async spawn(spec:AgentSpec){if(spec.command === "/bin/sh")return new NodeSpawner().spawn(spec);return {
  stdout:new ReadableStream<Uint8Array>({start(c){send=value=>c.enqueue(new TextEncoder().encode(JSON.stringify({jsonrpc:"2.0",...value})+"\n"));}}),
  stderr:new ReadableStream<Uint8Array>({start(c){c.close();}}),
  stdin:new WritableStream<Uint8Array>({async write(bytes){buffer+=new TextDecoder().decode(bytes);while(buffer.includes("\n")){const end=buffer.indexOf("\n");const m=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
   if(m.method==="initialize")send({id:m.id,result:{protocolVersion:1,agentCapabilities:{},agentInfo:{name:(mode === "sync-claude" || mode === "sync-agent") ? "@agentclientprotocol/claude-agent-acp" : "@agentclientprotocol/codex-acp",version:(mode === "sync-claude" || mode === "sync-agent") ? "0.75.1" : "1.8.0"}}});
   else if(m.method==="session/new")send({id:m.id,result:{sessionId:"native",configOptions}});
   else if(m.method==="session/set_config_option"){configOptions=configOptions.map(o=>({...o,currentValue:m.params.value}));send({id:m.id,result:{configOptions}});}
   else if(m.method==="session/prompt"){prompts++;order.push("model");if(mode === "joined")activities.register("bootstrap_"+session.id+":0", "tool:managed-child", activity.promise.then(async()=>{await writeFile(join(root,"activity.txt"),"drained");order.push("drain-done");}));draining.resolve();send({method:"session/update",params:{sessionId:"native",update:{sessionUpdate:"tool_call",toolCallId:prompts === 1 ? "managed-child" : "managed-child-"+prompts,title:"Managed child",status:"in_progress",kind:mode === "sync-command" ? "execute" : mode === "sync-agent" ? "other" : "read",...(mode === "sync-agent" ? {_meta:{claudeCode:{toolName:"Agent"}}} : {})}}});if(mode.startsWith("sync") || mode === "detached" || outcomeMode)send({method:"session/update",params:{sessionId:"native",update:{sessionUpdate:"tool_call_update",toolCallId:prompts === 1 ? "managed-child" : "managed-child-"+prompts,status:"completed",...(mode === "sync-command" ? {_meta:{terminal_exit:{exit_code:0,terminal_id:"managed-child",signal:null}}} : {}),...(mode === "sync-agent" ? {_meta:{claudeCode:{toolName:"Agent",toolResponse:{isAsync:false,status:"completed"}}}} : {}),...(mode === "detached" ? {_meta:{jetbrains:{air:{asyncTasks:{backgrounded:true}}}}} : {})}}});send({method:"session/update",params:{sessionId:"native",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:prompts>1?"hello":"draft"}}}});send({id:m.id,result:{stopReason:"end_turn"}});}
  }}}),async kill(){exit.resolve();},exited:exit.promise.then(()=>({code:0,signal:null})),
 };}};
 finalRoutes=buildWorkFinalizationRoutes({
  authenticate:(token,method,path)=>authenticateWorkFinalizationBearer({token,method,path,crypto:components.secrets!.cipherFor("managed.environment-work.session-token"),now:()=>new Date(),find:claim=>store.find(claim)}),
  applicationFor:async()=>new WorkFinalizationApplication({persistence:new SqlWorkFinalization(sql),host:{
   async prepare(scope){expect(await scope.isCurrent()).toBe(true);if(mode === "joined")expect(await readFile(join(root,"activity.txt"),"utf8")).toBe("drained");order.push("storage");return {type:"prepared"};},
   async publish(scope){expect(await scope.isCurrent()).toBe(true);order.push("artifacts");published.resolve();return {type:"published"};},
  }}),
 });
 const requests:string[]=[];const renewedDuringDrain=deferred(),interrupted=deferred();
 const fetcher:typeof fetch=async(raw,init)=>{const requestUrl=new URL(String(raw));

 if(requestUrl.pathname.endsWith("runtime-events")) outcomeSpans.push(...JSON.parse(String(init?.body)).events.filter((event:any)=>event.type.startsWith("span.outcome_evaluation")));
 const action=requestUrl.pathname.split('/').at(-1)!;requests.push(action);const response=await fetch(raw,init);if(response.ok&&action==="runtime-events"&&JSON.parse(String(init?.body)).events.some((e:any)=>e.type==="span.outcome_evaluation_end"&&e.result==="interrupted"))interrupted.resolve();if(action==="heartbeat"&&response.ok&&order.includes("model"))renewedDuringDrain.resolve();return response;};
 const executionToken=outcomeMode?await issueSandboxToken(createSqlEnvironmentWorkSandboxTokenStore(sql),environmentWorkSandboxTokenRef({...scope,generation:2}),{scope:"all"}):undefined;
 const running=runNodeWorkItemCli({workspacePath:root,signal:controller.signal,environment:{ANTHROPIC_ENVIRONMENT_ID:scope.environmentId,ANTHROPIC_SESSION_ID:scope.sessionId,ANTHROPIC_WORK_ID:scope.workId,OPENMA_WORKSPACE_ID:"untrusted-env-value",...(executionToken?{OPENMA_SANDBOX_TOKEN:executionToken}:{}),OPENMA_HARNESS_ID:"acp",OPENMA_ACP_AGENT_ID:(mode === "sync-claude" || mode === "sync-agent") ? "claude-acp" : "codex-acp",ANTHROPIC_WORK_SECRET:Buffer.from(JSON.stringify({sessions_token:token,api_base_url:base})).toString("base64url")},fetch:fetcher,heartbeatIntervalMs:20,

  runtime:{activities,spawner,modules:{control:{createSupervisor:common.createManagedAcpSupervisorHarness,createControlChannel:common.createManagedHarnessHttpControlChannel,applyPermissionMode:modes.applyAcpPermissionMode},createAcpRuntime:spawner=>new AcpRuntimeImpl(spawner)},
    stateIo:{async readFile(){throw Object.assign(Error("missing"),{code:"ENOENT"});},async writeFile(){},async writeFileBytes(){},async exec(){return "";}},
  },
 }).catch(error=>error);
 cleanup.push(async()=>{activity.resolve();controller.abort(Error("test shutdown"));await running;});
 await Promise.race([draining.promise,running.then(error=>{throw error;})]);
 expect(order).not.toContain("storage");expect(prompts).toBe(1);
 if(outcomeMode) {
   if(mode === "outcome-interrupt") {
     // Formal input ACK must include server-side settlement; an aborted Work
     // need not send a late runtime-events ACK after losing publication rights.
     await canonicalInterrupt.promise;
     expect(interruptReceipt).toMatchObject({data:[expect.objectContaining({type:"user.interrupt"})]});
     const documents=await sql.prepare("SELECT document FROM managed_session_events WHERE session_id=?").bind(session.id).all<{document:string}>();
     const durable=documents.results!.map(r=>JSON.parse(r.document));
     const starts=durable.filter(e=>e.type==="span.outcome_evaluation_start");
     const ends=durable.filter(e=>e.type==="span.outcome_evaluation_end");
     expect(starts).toHaveLength(1);expect(ends).toHaveLength(1);
     expect(ends[0]).toMatchObject({result:"interrupted",outcomeId:starts[0].outcomeId,iteration:starts[0].iteration,outcomeEvaluationStartId:starts[0].id});
     expect(ends[0].source_position.execution_id).toBe(starts[0].source_position.execution_id);
     expect(ends[0].source_position.environment_work).toEqual(starts[0].source_position.environment_work);
     const row=JSON.parse((await sql.prepare("SELECT document FROM managed_sessions WHERE id=?").bind(session.id).first<{document:string}>())!.document);
     expect(row.outcomeEvaluations).toEqual(expect.arrayContaining([expect.objectContaining({outcomeId:starts[0].outcomeId,iteration:starts[0].iteration,result:"interrupted",completedAt:ends[0].processedAt})]));
     console.log("OUTCOME INTERRUPT CANONICAL",JSON.stringify({receipt:interruptReceipt,start:starts[0],end:ends[0],aggregate:row.outcomeEvaluations}));
     await running;
     expect(prompts).toBe(1);expect(grades).toBe(1);
     expect(order).not.toContain("storage");expect(order).not.toContain("artifacts");return;
   }
   if(mode === "outcome-abort") { await running; expect(order).not.toContain("storage"); expect(order).not.toContain("artifacts"); return; }
   await Promise.race([published.promise,running.then(error=>{throw error;})]);
   if(!order.includes("storage")) throw await running;
   const ends=outcomeSpans.filter(e=>e.type === "span.outcome_evaluation_end");
   expect(ends.at(-1)?.result,JSON.stringify(ends)).toBe(mode === "outcome-max" ? "max_iterations_reached" : mode === "outcome-failed" || mode === "outcome-budget" ? "failed" : "satisfied");
   expect(prompts).toBe(mode === "outcome-failed" ? 1 : 2);
   if(grades)expect(ends[0].usage).toMatchObject({input_tokens:11,output_tokens:3});
   expect(order).toContain("storage"); expect(requests).toContain("work-finalize");
   const durable=(await sql.prepare("SELECT document FROM managed_session_events WHERE session_id=?").bind(session.id).all<{document:string}>()).results!.map(row=>JSON.parse(row.document));
   expect(durable.filter(e=>e.type === "span.outcome_evaluation_end").map(e=>e.result)).toEqual(ends.map(e=>e.result));
   const saved=JSON.parse((await sql.prepare("SELECT document FROM managed_sessions WHERE id=?").bind(session.id).first<{document:string}>())!.document);
   expect(saved.outcomeEvaluations, "canonical definition must initialize outcome aggregate").toEqual(expect.arrayContaining([expect.objectContaining({result:ends.at(-1).result})]));
   if(grades) expect(saved.usage).toMatchObject({inputTokens:(grades)*11,outputTokens:(grades)*3});
   if(mode === "outcome-budget") {
     expect(grades).toBe(1);
     expect(durable.find(e=>e.type === "session.status_idle" && e.stopReason?.type === "budget_reached")).toBeDefined();
   }
   return;
 }
 if (mode.startsWith("sync")) {
   await Promise.race([published.promise,running.then(error=>{throw error;})]);
   if(!order.includes("storage")) throw await running;
   expect(order).toContain("storage"); expect(order).toContain("artifacts");
   expect(requests).toContain("work-finalize"); expect(requests).toContain("work-publish");
   if (mode === "sync-agent") {
     const rows = await sql.prepare("SELECT document FROM managed_session_events WHERE session_id=? ORDER BY json_extract(document,'$.source_position.revision'),json_extract(document,'$.source_position.index')").bind(session.id).all<{document:string}>();
     const facts = rows.results!.map(row => JSON.parse(row.document));
     const created = facts.find(event => event.type === "session.thread_created");
     expect(created).toMatchObject({sessionThreadId:"acp:claude:managed-child",parentToolUseId:"managed-child",source_position:{execution_id:"bootstrap_"+session.id+":0",environment_work:{workId:scope.workId,generation:2}}});
     expect(facts.filter(event=>event.type==="session.thread_created")).toHaveLength(1);
     const parentTool=facts.findIndex(event=>event.type==="agent.tool_use"&&event.id==="managed-child");
     const childDone=facts.findIndex(event=>event.type==="session.thread_status_idle"&&event.sessionThreadId===created.sessionThreadId);
     const terminal=facts.findIndex(event=>event.type==="session.status_idle"&&event.stopReason?.type==="end_turn");
     expect(parentTool).toBeGreaterThanOrEqual(0);expect(parentTool).toBeLessThan(facts.indexOf(created));
     expect(childDone).toBeGreaterThan(facts.indexOf(created));expect(terminal).toBeGreaterThan(childDone);
     expect(facts.filter(event=>event.type==="session.status_idle"&&event.stopReason?.type==="end_turn")).toHaveLength(1);
   }
   return;
 }
 if (mode === "pending" || mode === "detached") {
   const failure = await running;
   expect(failure).toBeInstanceOf(Error);
   expect(order).not.toContain("storage"); expect(order).not.toContain("artifacts");
   expect(requests).not.toContain("work-failed"); expect(requests).not.toContain("work-finalize"); expect(requests).not.toContain("work-publish");
   return;
 }
 await Promise.race([renewedDuringDrain.promise,running.then(error=>{throw error;})]);
 expect(order).not.toContain("storage");
 activity.resolve();await Promise.race([published.promise,running.then(error=>{throw error;})]);
 expect(order.indexOf("drain-done")).toBeLessThan(order.indexOf("storage"));expect(order.indexOf("storage")).toBeLessThan(order.indexOf("artifacts"));
 expect(requests.indexOf("work-bootstrap")).toBeLessThan(requests.indexOf("work-recovery"));expect(requests.indexOf("work-recovery")).toBeLessThan(requests.indexOf("inputs-consume"));expect(requests).toContain("heartbeat");expect(requests).toContain("work-checkpoint");expect(requests).toContain("work-finalize");expect(requests).not.toContain("stop");
 } finally {for(const close of cleanup.reverse())await close();}
},20000);
