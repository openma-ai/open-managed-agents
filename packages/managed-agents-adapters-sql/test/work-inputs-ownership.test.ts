import { afterAll,describe,expect,it } from "vitest";
import { URL } from "node:url";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createBetterSqlite3SqlClient,type SqlClient } from "@open-managed-agents/sql-client";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlWorkInputs } from "../src/work-inputs";
import { WorkInputsApplication } from "../../managed-agents-application/src/session-execution/work-inputs";
import { buildWorkInputRoutes } from "../../http-routes/src/work-inputs";
const cleanup:Array<()=>Promise<void>>=[];afterAll(async()=>{for(const close of cleanup)await close();});
const claim={workspaceId:"ws",sessionId:"s",environmentId:"env",workId:"w",generation:2,holder:"holder"};
for(const d1 of [false,true])describe(d1?"D1 ownership":"SQLite ownership",()=>{
 async function fixture(){
  let sql:SqlClient;
  if(d1){const require=createRequire(import.meta.url);const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve("wrangler/package.json"))("miniflare");const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:"2026-11-01",d1Databases:["DB"]}));cleanup.push(()=>mf.dispose());sql=new CfD1SqlClient(await mf.getD1Database("DB"));}
  else sql=await createBetterSqlite3SqlClient(":memory:");
  await sql.exec("CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,environment_id TEXT,archived_at INTEGER,revision INTEGER,PRIMARY KEY(workspace_id,id));CREATE TABLE managed_environment_work(workspace_id TEXT,environment_id TEXT,id TEXT,session_id TEXT,state TEXT,claim_generation INTEGER,claim_worker_id TEXT,claim_at INTEGER,heartbeat_ttl_seconds INTEGER,PRIMARY KEY(workspace_id,id));CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,id TEXT,type TEXT,document TEXT,processed_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));CREATE TABLE managed_session_initial_events(workspace_id TEXT,session_id TEXT,sequence INTEGER,document TEXT,PRIMARY KEY(workspace_id,session_id,sequence));INSERT INTO managed_sessions VALUES('ws','s','env',NULL,1);");
  await sql.prepare("INSERT INTO managed_environment_work VALUES('ws','env','w','s','active',2,'holder',?,90)").bind(Date.now()).run();
  for(const statement of (await readFile(new URL("../../../apps/main-node/migrations-sqlite/0034_work_inputs.sql",import.meta.url),"utf8")).split("--> statement-breakpoint"))await sql.prepare(statement).run();
  const store=new SqlWorkInputs(sql,{sourcePositionsValidated:true});
  const insert=async(event:Record<string,unknown>,revision:number,source:Record<string,unknown>={})=>{
   const document=JSON.stringify({...event,source_position:{revision,index:0,...source}});
   await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s',?,?,?,0)").bind(event.id,event.type,document).run();
   await sql.prepare("UPDATE managed_sessions SET revision=?").bind(revision).run();return document;
  };
  const read=async(id:string)=>(await sql.prepare("SELECT document FROM managed_session_events WHERE id=?").bind(id).first<{document:string}>())!.document;
  const root=await insert({id:"root",type:"user.message",content:[],processedAt:null},2,{execution_id:"root-turn"});
  const consumeRoot=()=>store.consume({claim,inputId:"root",turnId:"root-turn",expectedDocument:root,boundary:"before_dispatch"});
  const tool=async(source:Record<string,unknown>={})=>insert({id:"tool",type:"agent.tool_use",name:"bash",input:{command:"echo yes"},evaluatedPermission:"ask",processedAt:new Date().toISOString()},4,{execution_id:"root-turn",environment_work:{workId:"w",generation:2},...source});
  const answer=async()=>insert({id:"answer",type:"user.tool_confirmation",toolUseId:"tool",result:"allow",processedAt:null},6,{execution_id:"answer-dispatch"});
  const request=async(raw:string)=>({claim,inputId:"answer",turnId:"answer-dispatch",consumingTurnId:"root-turn",rootInputId:"root",expectedRootDocument:await read("root"),expectedDocument:raw,boundary:"before_dispatch" as const});
  return {sql,store,insert,read,consumeRoot,tool,answer,request,root};
 }
 it("proves absorbed confirmation ownership through real SQL and private HTTP, requires_action is not completion",async()=>{
  const f=await fixture();expect(await f.consumeRoot()).toMatchObject({type:"consumed"});
  expect(JSON.parse(await f.read("root")).source_position.consumption_claim).toEqual({workId:"w",generation:2,holder:"holder"});
  await f.tool();await f.insert({id:"park",type:"session.status_idle",stopReason:{type:"requires_action",eventIds:["tool"]},processedAt:new Date().toISOString()},5,{execution_id:"root-turn",environment_work:{workId:"w",generation:2}});
  const input=await f.request(await f.answer());
  const route=buildWorkInputRoutes({authenticate:async()=>claim,applicationFor:async()=>new WorkInputsApplication(f.store)});
  const {claim:_,...body}=input;
  const send=()=>route.request("/s/inputs-consume",{method:"POST",headers:{authorization:"Bearer work","content-type":"application/json"},body:JSON.stringify(body)});
  const response=await send();expect(response.status,await response.clone().text()).toBe(200);
  expect(await response.json()).toEqual({type:"consumed",inputId:"answer",turnId:"answer-dispatch",consumingTurnId:"root-turn",boundary:"before_dispatch"});
  expect(JSON.parse(await f.read("answer")).source_position).toMatchObject({execution_id:"answer-dispatch",consumed_by_execution_id:"root-turn",consumption_claim:{workId:"w",generation:2,holder:"holder"}});
  expect((await send()).status).toBe(409);
 });
 it.each(["unconsumed","legacy","wrong-root","wrong-claim","unattributed-tool","foreign-tool","completed","old-terminal","queued"])("rejects %s ownership without altering input",async mode=>{
  const f=await fixture();if(mode!=="unconsumed")await f.consumeRoot();
  if(mode==="legacy")await f.sql.exec("UPDATE managed_session_events SET document=json_remove(document,'$.source_position.consumption_claim') WHERE id='root'");
  await f.tool(mode==="unattributed-tool"?{execution_id:undefined}:mode==="foreign-tool"?{execution_id:"different-root"}:{});
  if(mode==="completed"||mode==="old-terminal")await f.insert({id:"terminal",type:"session.status_idle",stopReason:{type:"end_turn"},processedAt:new Date().toISOString()},5,{execution_id:"root-turn",environment_work:{workId:"w",generation:mode==="old-terminal"?1:2}});
  let raw=await f.answer();if(mode==="queued"){const event=JSON.parse(raw);event._queued=true;raw=JSON.stringify(event);await f.sql.prepare("UPDATE managed_session_events SET document=? WHERE id='answer'").bind(raw).run();}
  const input=await f.request(raw);
  const result=await f.store.consume({...input,...(mode==="wrong-root"?{consumingTurnId:"unrelated"}:{}),...(mode==="wrong-claim"?{claim:{...claim,holder:"other"}}:{})});
  expect(result.type).not.toBe("consumed");expect(await f.read("answer")).toBe(raw);
 });
 it("rejects an already consumed distinct successor instead of absorbing into an unrelated root",async()=>{
  const f=await fixture();await f.consumeRoot();
  const next=await f.insert({id:"next",type:"user.message",content:[],processedAt:null},4,{execution_id:"next-turn"});
  expect(await f.store.consume({claim,inputId:"next",turnId:"next-turn",expectedDocument:next,boundary:"before_dispatch"})).toMatchObject({type:"consumed"});
  const steer=await f.insert({id:"steer",type:"user.message",content:[],processedAt:null},6,{execution_id:"steer-dispatch"});
  expect(await f.store.consume({claim,inputId:"steer",turnId:"steer-dispatch",consumingTurnId:"root-turn",rootInputId:"root",expectedRootDocument:await f.read("root"),expectedDocument:steer,boundary:"before_dispatch"})).toEqual({type:"rejected"});
 });
 it("keeps root raw-CAS even if a bad writer omits revision on reassignment",async()=>{
  const f=await fixture();await f.consumeRoot();await f.tool();const input=await f.request(await f.answer());
  const mutate=()=>f.sql.exec("UPDATE managed_session_events SET document=json_set(document,'$.source_position.consumption_claim.holder','other') WHERE id='root'");
  const raced:SqlClient={prepare:s=>f.sql.prepare(s),exec:s=>f.sql.exec(s),batch:async ss=>{await mutate();return f.sql.batch(ss);},...(f.sql.batchChecked?{batchChecked:async(ss,validate)=>{await mutate();return f.sql.batchChecked!(ss,validate);}}:{})};
  expect(await new SqlWorkInputs(raced,{sourcePositionsValidated:true}).consume(input)).toEqual({type:"rejected"});expect(await f.read("answer")).toBe(input.expectedDocument);
 });
 it("does not accept root proof from a different Work generation",async()=>{
  const f=await fixture();await f.consumeRoot();await f.tool();const input=await f.request(await f.answer());
  await f.sql.exec("UPDATE managed_environment_work SET claim_generation=3");
  expect(await f.store.consume({...input,claim:{...claim,generation:3}})).toEqual({type:"rejected"});
 });
 it("requires an approval-requesting canonical tool for a confirmation",async()=>{
  const f=await fixture();await f.consumeRoot();await f.tool();
  await f.sql.exec("UPDATE managed_session_events SET document=json_set(document,'$.evaluatedPermission','allow') WHERE id='tool'");
  const input=await f.request(await f.answer());expect(await f.store.consume(input)).toEqual({type:"rejected"});
 });
 it("does not omit an unpositioned terminal from ownership proof",async()=>{
  const f=await fixture();await f.consumeRoot();await f.tool();const input=await f.request(await f.answer());
  await f.sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','legacy-end','session.status_idle',?,0)").bind(JSON.stringify({id:"legacy-end",type:"session.status_idle",stopReason:{type:"end_turn"},processedAt:new Date().toISOString()})).run();
  expect(await f.store.consume(input)).toEqual({type:"rejected"});
 });
 it("supports a newly consumed bootstrap root but never infers ownership for an old root",async()=>{
  const f=await fixture();await f.sql.exec("DELETE FROM managed_session_events");
  const raw=JSON.stringify({id:"bootstrap_s:0",type:"user.message",content:[],processedAt:null,source_position:{revision:1,index:0}});
  await f.sql.prepare("INSERT INTO managed_session_initial_events VALUES('ws','s',0,?)").bind(raw).run();
  expect(await f.store.consume({claim,inputId:"bootstrap_s:0",turnId:"bootstrap_s:0",expectedDocument:raw,boundary:"before_dispatch"})).toMatchObject({type:"consumed"});
  const root=(await f.sql.prepare("SELECT document FROM managed_session_initial_events").first<{document:string}>())!.document;
  const child=await f.insert({id:"steer",type:"user.message",content:[],processedAt:null},4);
  expect(await f.store.consume({claim,inputId:"steer",turnId:"steer",consumingTurnId:"bootstrap_s:0",rootInputId:"bootstrap_s:0",expectedRootDocument:root,expectedDocument:child,boundary:"before_dispatch"})).toMatchObject({type:"consumed"});
 });
 it("rejects an already settled tool request instead of approving it twice",async()=>{
  const f=await fixture();await f.consumeRoot();await f.tool();
  await f.insert({id:"tool-finished",type:"agent.tool_result",toolUseId:"tool",content:[],processedAt:new Date().toISOString()},5,{execution_id:"root-turn",environment_work:{workId:"w",generation:2}});
  const input=await f.request(await f.answer());expect(await f.store.consume(input)).toEqual({type:"rejected"});
 });
 it("refuses truncated root history proof",async()=>{
  const f=await fixture();await f.consumeRoot();
  for(let i=0;i<201;i++)await f.insert({id:"fact_"+i,type:"agent.message",content:[],processedAt:new Date().toISOString()},4+i,{execution_id:"root-turn"});
  const child=await f.insert({id:"steer",type:"user.message",content:[],processedAt:null},210);
  expect(await f.store.consume({claim,inputId:"steer",turnId:"steer",consumingTurnId:"root-turn",rootInputId:"root",expectedRootDocument:await f.read("root"),expectedDocument:child,boundary:"before_dispatch"})).toEqual({type:"rejected"});
 });
 it("explicit steer absorption does not relabel a queued next prompt or auto-consume it",async()=>{
  const f=await fixture();await f.consumeRoot();
  const steer=await f.insert({id:"steer",type:"user.message",content:[],processedAt:null},4,{execution_id:"steer-dispatch"});
  const next=await f.insert({id:"next",type:"user.message",content:[],processedAt:null,_queued:true},5,{execution_id:"next-turn"});
  expect(await f.store.consume({claim,inputId:"steer",turnId:"steer-dispatch",consumingTurnId:"root-turn",rootInputId:"root",expectedRootDocument:await f.read("root"),expectedDocument:steer,boundary:"before_dispatch"})).toMatchObject({type:"consumed",consumingTurnId:"root-turn"});
  expect(await f.read("next")).toBe(next);
 });
 it("refuses root evidence changed or a completion appended between proof and transaction",async()=>{
  const f=await fixture();await f.consumeRoot();await f.tool();const input=await f.request(await f.answer());
  const mutate=async()=>{await f.insert({id:"terminal",type:"session.status_idle",stopReason:{type:"end_turn"},processedAt:new Date().toISOString()},7,{execution_id:"root-turn",environment_work:{workId:"w",generation:2}});};
  const raced:SqlClient={prepare:s=>f.sql.prepare(s),exec:s=>f.sql.exec(s),batch:async ss=>{await mutate();return f.sql.batch(ss);},...(f.sql.batchChecked?{batchChecked:async(ss,validate)=>{await mutate();return f.sql.batchChecked!(ss,validate);}}:{})};
  expect(await new SqlWorkInputs(raced,{sourcePositionsValidated:true}).consume(input)).toEqual({type:"rejected"});expect(await f.read("answer")).toBe(input.expectedDocument);
 });
});
