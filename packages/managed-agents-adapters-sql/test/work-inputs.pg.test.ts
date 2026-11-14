import { URL } from "node:url";
import { afterAll, beforeAll, beforeEach, expect, inject, it } from "vitest";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { PostgresSqlClient } from "@open-managed-agents/sql-client/adapters/postgres";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { SqlWorkInputs } from "../src/work-inputs";
import type { StorageIntegrationConfig } from "../../../test/storage-integration.js";
const url=process.env.WORK_INPUTS_PG_URL ?? (inject("storageIntegration") as StorageIntegrationConfig | undefined)?.postgres.workInputs;
const parsed=url ? new URL(url) : null;
// Refuse shared/live lane databases BEFORE opening a connection. The explicit
// opt-in config never participates in the default package suite.
if (!parsed || !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    !/^\/openma_work_inputs_test_[a-z0-9_]+$/.test(parsed.pathname) || parsed.search || parsed.hash) {
  throw Error("WORK_INPUTS_PG_URL must name a dedicated loopback openma_work_inputs_test_* database (no connection options)");
}
const schema="work_inputs_"+crypto.randomUUID().replaceAll("-", "");
let createdSchema=false;
let sql:PostgresSqlClient;
let connection:ReturnType<typeof postgres>;
const claim={workspaceId:"ws",sessionId:"s",environmentId:"env",workId:"w",generation:1,holder:"worker"};
const doc=JSON.stringify({id:"input",type:"user.message",content:[],processedAt:null,source_position:{revision:2,index:0}});
beforeAll(async()=>{
 connection=postgres(url!, {max:4,connection:{search_path:schema},types:{bigint:{to:20,from:[20],serialize:(v:number)=>String(v),parse:Number}}});
 sql=new PostgresSqlClient(connection as unknown as ConstructorParameters<typeof PostgresSqlClient>[0]);
 const database=await sql.prepare("SELECT current_database() AS name").first<{name:string}>();
 if(database?.name !== parsed!.pathname.slice(1))throw Error("Unexpected test database");
 await sql.exec(`CREATE SCHEMA "${schema}"`); createdSchema=true;
});
beforeEach(async()=>{
 await sql.exec(`DROP TABLE IF EXISTS "${schema}".work_inputs_source_position_preflight, "${schema}".managed_session_initial_events,"${schema}".managed_session_events,"${schema}".managed_sessions,"${schema}".managed_environment_work;
 CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,environment_id TEXT,archived_at BIGINT,revision BIGINT);
 CREATE TABLE managed_environment_work(workspace_id TEXT,environment_id TEXT,id TEXT,session_id TEXT,state TEXT,claim_generation BIGINT,claim_worker_id TEXT,claim_at BIGINT,heartbeat_ttl_seconds BIGINT);
 CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,id TEXT,document TEXT,processed_at BIGINT);
 CREATE TABLE managed_session_initial_events(workspace_id TEXT,session_id TEXT,sequence BIGINT,document TEXT,PRIMARY KEY(workspace_id,session_id,sequence));
 INSERT INTO managed_sessions VALUES('ws','s','env',NULL,2);
 INSERT INTO managed_environment_work VALUES('ws','env','w','s','active',1,'worker',1000,90);`);
 await sql.exec("UPDATE managed_environment_work SET claim_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint");
});
afterAll(async()=>{
 try { if(createdSchema)await sql.exec(`DROP SCHEMA "${schema}" CASCADE`); }
 finally { await connection?.end(); }
});
it("validates the PostgreSQL migration and performs indexed seek + exactly one concurrent consume",async()=>{
 await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','input',?,NULL)").bind(doc).run();
 const migration=await readFile(new URL("../../../apps/main-node/migrations/0034_work_inputs.sql",import.meta.url),"utf8");
 await sql.exec(migration);
 const store=new SqlWorkInputs(sql,{dialect:"postgres",sourcePositionsValidated:true,});
 expect(await store.read({claim,after:null,limit:1})).toMatchObject({type:"page",rows:[{event:{id:"input"}}],hasMore:false});
 const input={claim,inputId:"input",turnId:"input",expectedDocument:doc,boundary:"before_dispatch" as const};
 const results=await Promise.all([store.consume(input),store.consume(input)]);
 expect(results.filter(r=>r.type==="consumed")).toHaveLength(1);
 expect(await sql.prepare("SELECT revision FROM managed_sessions").first()).toEqual({revision:3});
});

const migrate=async()=>sql.exec(await readFile(new URL("../../../apps/main-node/migrations/0034_work_inputs.sql",import.meta.url),"utf8"));
it.each([{}, {revision:0,index:0}, {revision:2,index:-1}, {revision:2.5,index:0}, {revision:"2",index:0}, {revision:9007199254740992,index:0}])("refuses invalid PG positions without changing input: %j",async position=>{
 const raw=JSON.stringify({...JSON.parse(doc),source_position:position});
 await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','input',?,123)").bind(raw).run();
 await expect(migrate()).rejects.toThrow(/source_position_required/);
 expect(await sql.prepare("SELECT document FROM managed_session_events").first()).toEqual({document:raw});
});
it("refuses duplicate PG source positions",async()=>{
 for(const id of ["one","two"])await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s',?,?,123)").bind(id,doc).run();
 await expect(migrate()).rejects.toThrow(/managed_session_events_source_position/);
});
it("seeks and consumes bootstrap then preserves internal resume data",async()=>{
 await migrate();
 const bootstrap=JSON.stringify({...JSON.parse(doc),id:"bootstrap_s:0",source_position:{revision:1,index:0}});
 const resume=JSON.stringify({id:"resume",type:"session.updated",resume:true,processedAt:null,source_position:{revision:2,index:0}});
 await sql.prepare("INSERT INTO managed_session_initial_events VALUES('ws','s',0,?)").bind(bootstrap).run();
 await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','resume',?,0)").bind(resume).run();
 const store=new SqlWorkInputs(sql,{dialect:"postgres",sourcePositionsValidated:true,});
 expect(await store.read({claim,after:null,limit:1})).toMatchObject({type:"page",rows:[{event:{id:"bootstrap_s:0",processedAt:null}}],hasMore:true});
 expect(await store.read({claim,after:{revision:1,index:0},limit:1})).toMatchObject({type:"page",rows:[{event:{resume:true},position:{revision:2,index:0},document:resume}]});
 expect(await store.consume({claim,inputId:"bootstrap_s:0",turnId:"bootstrap_s:0",expectedDocument:bootstrap,boundary:"before_dispatch"})).toMatchObject({type:"consumed"});
 expect(JSON.parse((await sql.prepare("SELECT document FROM managed_session_initial_events").first<{document:string}>())!.document).processedAt).toEqual(expect.any(String));
});
it.each(["claim_generation=3", "claim_worker_id='other'", "claim_at=-88000", "state='stopped'"])("fences PG read/consume for %s",async mutation=>{
 await migrate();await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','input',?,0)").bind(doc).run();
 await sql.exec("UPDATE managed_environment_work SET "+mutation);
 const store=new SqlWorkInputs(sql,{dialect:"postgres",sourcePositionsValidated:true,});
 expect(await store.read({claim,after:null,limit:1})).toEqual({type:"rejected"});
 expect(await store.consume({claim,inputId:"input",turnId:"input",expectedDocument:doc,boundary:"before_dispatch"})).toEqual({type:"rejected"});
 expect(await sql.prepare("SELECT document FROM managed_session_events").first()).toEqual({document:doc});
});
it("uses the PG source index for exclusive seek without sorting history",async()=>{
 await migrate();
 // Populate enough rows to make the real planner choose the ordered seek.
 await sql.exec(`INSERT INTO managed_session_events SELECT 'ws','s','e'||n,
  json_build_object('id','e'||n,'type','user.message','processedAt',null,'source_position',json_build_object('revision',n+2,'index',0))::text,0 FROM generate_series(1,10000) n;
  ANALYZE managed_session_events;`);
 const queries:string[]=[];
 const traced={prepare:(text:string)=>{if(text.startsWith("SELECT document FROM managed_session_events"))queries.push(text);return sql.prepare(text);},exec:sql.exec.bind(sql),batch:sql.batch.bind(sql)};
 await new SqlWorkInputs(traced,{dialect:"postgres",sourcePositionsValidated:true,}).read({claim,after:{revision:5000,index:0},limit:1});
 expect(queries).toHaveLength(2);
 for(const [index,query] of queries.entries()){
  const plan=await sql.prepare("EXPLAIN (FORMAT JSON) "+query).bind(...(index===0?["ws","s",5000,0,2]:["ws","s",5000,2])).all();
  const text=JSON.stringify(plan.results);
  expect(text).toContain('managed_session_events_source_position');
  expect(text).not.toContain('"Node Type":"Sort"');
  expect(text).not.toContain('"Node Type":"Seq Scan"');
 }
});
it.each([
 {type:"user.define_outcome",description:"Report",rubric:{type:"text",content:"A and B"},maxIterations:4,outcomeId:"outcome_pg"},
 {type:"user.tool_result",toolUseId:"tool_pg",content:[{type:"text",text:"done"}],isError:false},
 {type:"session.updated",resume:true,budget:{tokens:10000}},
])("consumes PG runnable $type with its accepted stamp and complete payload",async payload=>{
 await migrate();
 const original={...payload,id:"input",processedAt:"1970-01-01T00:00:01.000Z",source_position:{revision:2,index:0,execution_id:"stable-pg-turn"}};
 const raw=JSON.stringify(original);
 await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','input',?,1000)").bind(raw).run();
 const store=new SqlWorkInputs(sql,{dialect:"postgres",sourcePositionsValidated:true,});
 const input={claim,inputId:"input",turnId:"stable-pg-turn",expectedDocument:raw,boundary:"before_dispatch" as const};
 const results=await Promise.all([store.consume(input),store.consume(input)]);
 expect(results.filter(r=>r.type==="consumed")).toHaveLength(1);
 expect(JSON.parse((await sql.prepare("SELECT document FROM managed_session_events").first<{document:string}>())!.document)).toEqual({...original,source_position:{...original.source_position,consumed_by_execution_id:"stable-pg-turn",consumption_claim:{workId:claim.workId,generation:claim.generation,holder:claim.holder}}});
 const stamp=await sql.prepare("SELECT processed_at FROM managed_session_events").first<{processed_at:number}>();
 expect(stamp!.processed_at).toBeGreaterThan(Date.now()-10000);expect(stamp!.processed_at).toBeLessThanOrEqual(Date.now());
});
it("rejects PG ordinary updates and truthy non-boolean resume",async()=>{
 await migrate();
 for(const resume of [false,"true",1,null]){
  const raw=JSON.stringify({id:"input",type:"session.updated",resume,budget:{tokens:10000},processedAt:null,source_position:{revision:2,index:0}});
  await sql.exec("DELETE FROM managed_session_events");
  await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','input',?,0)").bind(raw).run();
  expect(await new SqlWorkInputs(sql,{dialect:"postgres",sourcePositionsValidated:true,}).consume({claim,inputId:"input",turnId:"input",expectedDocument:raw,boundary:"before_dispatch"})).toEqual({type:"rejected"});
 }
});

it.each(["managed_sessions","managed_environment_work","managed_session_events"])("rejects expiry after a real PG row lock wait on %s (not transaction start time)",async table=>{
 await migrate();
 await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','input',?,0)").bind(doc).run();
 await sql.exec("UPDATE managed_environment_work SET claim_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint-89200");
 let unlock!:()=>void,locked!:()=>void;
 const gate=new Promise<void>(r=>unlock=r),ready=new Promise<void>(r=>locked=r);
 const blocker=connection.begin(async tx=>{await tx.unsafe(`SELECT * FROM ${table} FOR UPDATE`);locked();await gate;});
 await ready;
 const result=new SqlWorkInputs(sql,{dialect:"postgres",sourcePositionsValidated:true}).consume({claim,inputId:"input",turnId:"input",expectedDocument:doc,boundary:"before_dispatch"});
 try {
   // Observe actual lock waiting in the server, rather than assume a JS delay
   // means the transaction has started.
   let waiting=false;
   for(let n=0;n<80&&!waiting;n++){
     const rows=await connection.unsafe("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'");
     waiting=rows.length>0;if(!waiting)await new Promise(r=>setTimeout(r,10));
   }
   expect(waiting).toBe(true);
   await connection.unsafe("SELECT pg_sleep(0.9)");
 } finally {unlock();await blocker;}
 expect(await result).toEqual({type:"rejected"});
 expect(await sql.prepare("SELECT document,processed_at FROM managed_session_events").first()).toEqual({document:doc,processed_at:0});
 expect(await sql.prepare("SELECT revision FROM managed_sessions").first()).toEqual({revision:2});
});
it("uses subsecond PG execution time after a queued transaction begins",async()=>{
 await migrate();await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','input',?,0)").bind(doc).run();
 await sql.exec("UPDATE managed_environment_work SET claim_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint");
 const delayed:SqlClient={prepare:sql.prepare.bind(sql),exec:sql.exec.bind(sql),batch:sql.batch.bind(sql),batchChecked:async (statements,validate)=>{
   await new Promise(r=>setTimeout(r,120));return sql.batchChecked(statements,validate);
 }};
 const before=Date.now()+100;
 expect(await new SqlWorkInputs(delayed,{dialect:"postgres",sourcePositionsValidated:true}).consume({claim,inputId:"input",turnId:"input",expectedDocument:doc,boundary:"before_dispatch"})).toMatchObject({type:"consumed"});
 const row=await sql.prepare("SELECT document,processed_at FROM managed_session_events").first<{document:string;processed_at:number}>();
 expect(row!.processed_at).toBeGreaterThanOrEqual(before);expect(row!.processed_at).toBeLessThanOrEqual(Date.now());
 // Two clock_timestamp() evaluations need not share one millisecond.
 // Both must prove actual execution after the queued wait, not acceptance time.
 const documentStamp=Date.parse(JSON.parse(row!.document).processedAt);
 expect(documentStamp).toBeGreaterThanOrEqual(before);
 expect(documentStamp).toBeLessThanOrEqual(Date.now());
});
it("stamps PG input only after obtaining the input row lock",async()=>{
 await migrate();await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','input',?,0)").bind(doc).run();
 let unlock!:()=>void,locked!:()=>void;const gate=new Promise<void>(r=>unlock=r),ready=new Promise<void>(r=>locked=r);
 const blocker=connection.begin(async tx=>{await tx.unsafe("SELECT * FROM managed_session_events FOR UPDATE");locked();await gate;});
 await ready;
 const result=new SqlWorkInputs(sql,{dialect:"postgres",sourcePositionsValidated:true}).consume({claim,inputId:"input",turnId:"input",expectedDocument:doc,boundary:"before_dispatch"});
 let released=0;
 try{
  let waiting=false;for(let n=0;n<80&&!waiting;n++){waiting=(await connection.unsafe("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")).length>0;if(!waiting)await new Promise(r=>setTimeout(r,10));}
  expect(waiting).toBe(true);await connection.unsafe("SELECT pg_sleep(0.15)");released=Date.now();
 }finally{unlock();await blocker;}
 expect(await result).toMatchObject({type:"consumed"});
 const row=await sql.prepare("SELECT document,processed_at FROM managed_session_events").first<{document:string;processed_at:number}>();
 expect(row!.processed_at).toBeGreaterThanOrEqual(released);
 expect(Date.parse(JSON.parse(row!.document).processedAt)).toBeGreaterThanOrEqual(released);
});
it("proves PG actual consumer ownership while preserving the answer dispatch identity",async()=>{
 await migrate();await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s','input',?,0)").bind(doc).run();
 const store=new SqlWorkInputs(sql,{dialect:"postgres",sourcePositionsValidated:true});
 await store.consume({claim,inputId:"input",turnId:"input",expectedDocument:doc,boundary:"before_dispatch"});
 const root=(await sql.prepare("SELECT document FROM managed_session_events WHERE id='input'").first<{document:string}>())!.document;
 const tool=JSON.stringify({id:"tool",type:"agent.tool_use",evaluatedPermission:"ask",processedAt:new Date().toISOString(),source_position:{revision:4,index:0,execution_id:"input",environment_work:{workId:"w",generation:1}}});
 const answer=JSON.stringify({id:"answer",type:"user.tool_confirmation",toolUseId:"tool",result:"allow",processedAt:null,source_position:{revision:5,index:0,execution_id:"answer-dispatch"}});
 for(const [id,raw] of [["tool",tool],["answer",answer]])await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s',?,?,0)").bind(id,raw).run();
 await sql.exec("UPDATE managed_sessions SET revision=5");
 const request={claim,inputId:"answer",turnId:"answer-dispatch",consumingTurnId:"input",rootInputId:"input",expectedRootDocument:root,expectedDocument:answer,boundary:"before_dispatch" as const};
 expect(await store.consume(request)).toEqual({type:"consumed",inputId:"answer",turnId:"answer-dispatch",consumingTurnId:"input",boundary:"before_dispatch"});
 expect(JSON.parse((await sql.prepare("SELECT document FROM managed_session_events WHERE id='answer'").first<{document:string}>())!.document).source_position).toEqual({revision:5,index:0,execution_id:"answer-dispatch",consumed_by_execution_id:"input",consumption_claim:{workId:"w",generation:1,holder:"worker"}});
});
