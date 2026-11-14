import { URL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createBetterSqlite3SqlClient, type SqlClient, type SqlStatement } from "@open-managed-agents/sql-client";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlWorkInputs } from "../src/work-inputs";

const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler/package.json"))("miniflare");
const instances: Array<{ dispose(): Promise<void> }> = [];
afterAll(async () => { for (const mf of instances) await mf.dispose(); });
const claim = { workspaceId: "ws", sessionId: "s", environmentId: "env", workId: "w", generation: 2, holder: "worker" };
const document = (id: string, revision: number, index: number) => JSON.stringify({ id, type: "user.message", content: [], processedAt: null, source_position: { revision, index } });
async function fixture(d1: boolean, indexed = true) {
  let sql: SqlClient;
  if (d1) {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default {fetch(){return new Response('ok')}}", compatibilityDate: "2026-11-01", d1Databases: ["DB"] }));
    instances.push(mf);
    sql = new CfD1SqlClient(await mf.getD1Database("DB"));
  } else sql = await createBetterSqlite3SqlClient(":memory:");
  await sql.exec(
    "CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,environment_id TEXT,archived_at INTEGER,revision INTEGER,PRIMARY KEY(workspace_id,id));" +
    "CREATE TABLE managed_environment_work(workspace_id TEXT,environment_id TEXT,id TEXT,session_id TEXT,state TEXT,claim_generation INTEGER,claim_worker_id TEXT,claim_at INTEGER,heartbeat_ttl_seconds INTEGER,PRIMARY KEY(workspace_id,id));" +
    "CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,id TEXT,type TEXT,document TEXT,processed_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));" +
    "CREATE TABLE managed_session_initial_events(workspace_id TEXT,session_id TEXT,sequence INTEGER,document TEXT,PRIMARY KEY(workspace_id,session_id,sequence));" +
    "INSERT INTO managed_sessions VALUES ('ws','s','env',NULL,4);" +
    "INSERT INTO managed_environment_work VALUES ('ws','env','w','s','active',2,'worker',1000,90);"
  );
  await sql.prepare("UPDATE managed_environment_work SET claim_at=?").bind(Date.now()).run();
  if (indexed) {
    const migration = await readFile(new URL("../../../apps/main-node/migrations-sqlite/0034_work_inputs.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map(s=>s.trim()).filter(Boolean)) await sql.prepare(statement).run();
  }
  for (const [id, revision, index] of [["z",2,0],["a",2,1],["later",4,0]] as const) {
    await sql.prepare("INSERT INTO managed_session_events VALUES ('ws','s',?,'user.message',?,999)").bind(id, document(id,revision,index)).run();
  }
  return { sql, store: new SqlWorkInputs(sql, { sourcePositionsValidated: true }), input: { claim, inputId: "z", turnId: "z", expectedDocument: document("z",2,0), boundary: "before_dispatch" as const } };
}
for (const d1 of [false,true]) describe(d1 ? "real workerd D1" : "real SQLite", () => {
  it("does not authorize redispatch after losing a successful real-clock commit response",async()=>{
    const {sql,input}=await fixture(d1);let lose=true;
    const lost:SqlClient={prepare:q=>sql.prepare(q),exec:q=>sql.exec(q),batch:async <T>(ss:SqlStatement[])=>{const result=await sql.batch<T>(ss);if(lose){lose=false;throw Error("lost after commit");}return result;},
      ...(sql.batchChecked?{batchChecked:async(ss,validate)=>{const result=await sql.batchChecked!(ss,validate);if(lose){lose=false;throw Error("lost after commit");}return result;}}:{})};
    const store=new SqlWorkInputs(lost,{sourcePositionsValidated:true});
    await expect(store.consume(input)).rejects.toThrow("lost after commit");
    expect(await store.consume(input)).toEqual({type:"gap",reason:"consumption_receipt_not_persisted"});
    expect(await sql.prepare("SELECT revision FROM managed_sessions").first()).toEqual({revision:5});
  });
  it("rejects a batch queued past the real database TTL without stamping input",async()=>{
    const {sql,input}=await fixture(d1);
    await sql.prepare("UPDATE managed_environment_work SET claim_at=?,heartbeat_ttl_seconds=90").bind(Date.now()-89800).run();
    const delay=()=>new Promise(resolve=>setTimeout(resolve,350));
    const queued:SqlClient={prepare:q=>sql.prepare(q),exec:q=>sql.exec(q),batch:async ss=>{await delay();return sql.batch(ss);},
      ...(sql.batchChecked?{batchChecked:async(ss,validate)=>{await delay();return sql.batchChecked!(ss,validate);}}:{})};
    expect(await new SqlWorkInputs(queued,{sourcePositionsValidated:true}).consume(input)).toEqual({type:"rejected"});
    expect(await sql.prepare("SELECT document,processed_at FROM managed_session_events WHERE id='z'").first()).toEqual({document:input.expectedDocument,processed_at:999});
    expect(await sql.prepare("SELECT revision FROM managed_sessions").first()).toEqual({revision:4});
  });
  it("stamps dispatch with the database execution clock after a delayed batch",async()=>{
    const {sql,input}=await fixture(d1);
    await sql.prepare("UPDATE managed_environment_work SET claim_at=?").bind(Date.now()).run();
    let releasedAt=0;
    const delay=async()=>{await new Promise(resolve=>setTimeout(resolve,150));releasedAt=Date.now();};
    const queued:SqlClient={prepare:q=>sql.prepare(q),exec:q=>sql.exec(q),batch:async ss=>{await delay();return sql.batch(ss);},
      ...(sql.batchChecked?{batchChecked:async(ss,validate)=>{await delay();return sql.batchChecked!(ss,validate);}}:{})};
    expect(await new SqlWorkInputs(queued,{sourcePositionsValidated:true}).consume(input)).toMatchObject({type:"consumed"});
    const row=await sql.prepare("SELECT document,processed_at FROM managed_session_events WHERE id='z'").first<{document:string;processed_at:number}>();
    expect(row!.processed_at).toBeGreaterThanOrEqual(releasedAt);
    expect(Date.parse(JSON.parse(row!.document).processedAt)).toBe(row!.processed_at);
    expect(row!.processed_at).toBeLessThanOrEqual(Date.now());
  });
  for (const payload of [
    {type:"user.custom_tool_result",customToolUseId:"custom_1",content:[{type:"text",text:"approved"}],isError:false},
    {type:"user.define_outcome",description:"A complete report",rubric:{type:"text",content:"All three checks pass"},maxIterations:5,outcomeId:"outcome_1"},
    {type:"user.define_outcome",description:"File rubric",rubric:{type:"file",fileId:"file_rubric"},maxIterations:null,outcomeId:"outcome_2"},
    {type:"user.tool_result",toolUseId:"tool_1",content:[{type:"text",text:"result"}],isError:false,sessionThreadId:"thread_1"},
    {type:"session.updated",resume:true,budget:{tokens:10000}},
  ]) for (const processedAt of [null,"1970-01-01T00:00:01.000Z"]) it("consumes runnable "+payload.type+" with stamp "+processedAt+" without dropping fields",async()=>{
    const {sql,store,input}=await fixture(d1);
    const original={...payload,id:"z",processedAt,source_position:{revision:2,index:0,execution_id:"stable-turn"}};
    const raw=JSON.stringify(original);
    await sql.prepare("UPDATE managed_session_events SET type=?,document=? WHERE id='z'").bind(payload.type,raw).run();
    const request={...input,expectedDocument:raw,turnId:"stable-turn"};
    expect(await store.consume({...request,turnId:"w:2"})).toEqual({type:"rejected"});
    expect(await store.consume({...request,expectedDocument:raw+" "})).toEqual({type:"rejected"});
    expect(await store.consume({...request,claim:{...claim,holder:"foreign"}})).toEqual({type:"rejected"});
    expect(await store.consume(request)).toEqual({type:"consumed",inputId:"z",turnId:"stable-turn",boundary:"before_dispatch"});
    const consumed=JSON.parse((await sql.prepare("SELECT document FROM managed_session_events WHERE id='z'").first<{document:string}>())!.document);
    expect(Date.parse(consumed.processedAt)).toBeLessThanOrEqual(Date.now());
    expect(consumed).toEqual({
      ...original,processedAt:processedAt??expect.any(String),source_position:{...original.source_position,consumed_by_execution_id:"stable-turn",consumption_claim:{workId:claim.workId,generation:claim.generation,holder:claim.holder}},
    });
    expect(await store.consume(request)).toEqual({type:"gap",reason:"consumption_receipt_not_persisted"});
    expect(await store.consume({...request,boundary:"after_acceptance"})).toEqual({type:"gap",reason:"acceptance_receipt_not_persisted"});
  });
  it("rejects ordinary updates and non-boolean resume without changing canonical bytes",async()=>{
    const {sql,store,input}=await fixture(d1);
    for(const update of [{title:"new"},{budget:{tokens:200}},{resume:false},{resume:"true"},{resume:1},{resume:null}]){
      const raw=JSON.stringify({id:"z",type:"session.updated",...update,processedAt:null,source_position:{revision:2,index:0}});
      await sql.prepare("UPDATE managed_session_events SET type='session.updated',document=? WHERE id='z'").bind(raw).run();
      expect(await store.consume({...input,expectedDocument:raw})).toEqual({type:"rejected"});
      expect(await sql.prepare("SELECT document FROM managed_session_events WHERE id='z'").first()).toEqual({document:raw});
    }
  });
  it("consumes a canonical bootstrap outcome with complete rubric",async()=>{
    const {sql,store}=await fixture(d1);
    const original={id:"bootstrap_s:0",type:"user.define_outcome",description:"Deliver",rubric:{type:"text",content:"A and B"},maxIterations:3,processedAt:null,source_position:{revision:1,index:0}};
    const raw=JSON.stringify(original);
    await sql.prepare("INSERT INTO managed_session_initial_events VALUES ('ws','s',0,?)").bind(raw).run();
    expect(await store.consume({claim,inputId:original.id,turnId:original.id,expectedDocument:raw,boundary:"before_dispatch"})).toMatchObject({type:"consumed"});
    expect(JSON.parse((await sql.prepare("SELECT document FROM managed_session_initial_events").first<{document:string}>())!.document)).toEqual({...original,processedAt:expect.any(String),source_position:{...original.source_position,consumed_by_execution_id:original.id,consumption_claim:{workId:claim.workId,generation:claim.generation,holder:claim.holder}}});
  });
  it("preserves canonical internal resume and position without the public event mapper", async () => {
    const {sql,store}=await fixture(d1);
    const raw=JSON.stringify({id:"resume",type:"session.updated",resume:true,processedAt:null,source_position:{revision:5,index:0}});
    await sql.prepare("INSERT INTO managed_session_events VALUES ('ws','s','resume','session.updated',?,0)").bind(raw).run();
    expect(await store.read({claim,after:{revision:4,index:0},limit:1})).toEqual({type:"page",rows:[{
      event:{id:"resume",type:"session.updated",resume:true,processedAt:null},position:{revision:5,index:0},document:raw,
    }],hasMore:false});
  });
  it("seeks exclusive source positions within one revision and keeps an empty tail", async () => {
    const {store,sql}=await fixture(d1);
    const first=await store.read({claim,after:null,limit:1});
    expect(first).toMatchObject({type:"page",rows:[{event:{id:"z"},position:{revision:2,index:0}}],hasMore:true});
    const next=await store.read({claim,after:{revision:2,index:0},limit:2});
    expect(next).toMatchObject({type:"page",rows:[{event:{id:"a"}},{event:{id:"later"}}],hasMore:false});
    await sql.exec("UPDATE managed_session_events SET processed_at=0 WHERE id='later'");
    expect(await store.read({claim,after:{revision:4,index:0},limit:2})).toEqual({type:"page",rows:[],hasMore:false});
  });
  it("refuses consumption on an unvalidated deployment",async()=>{
    const {sql,input}=await fixture(d1);
    expect(await new SqlWorkInputs(sql,{}).consume(input)).toEqual({type:"gap",reason:"source_position_validation_required"});
  });
  it("fails closed when the bootstrap validation index is missing",async()=>{
    const {sql,store}=await fixture(d1);
    await sql.exec("DROP INDEX managed_session_initial_events_source_position_invalid");
    expect(await store.read({claim,after:null,limit:1})).toEqual({type:"gap",reason:"source_position_index_required"});
  });
  it("fails closed without the ordered index rather than scanning history", async()=>{
    const {store}=await fixture(d1,false);
    expect(await store.read({claim,after:null,limit:2})).toEqual({type:"gap",reason:"source_position_index_required"});
  });
  it("resumes from empty tail after a new revision arrives",async()=>{
    const {sql,store}=await fixture(d1);
    const after={revision:4,index:0};
    expect(await store.read({claim,after,limit:2})).toEqual({type:"page",rows:[],hasMore:false});
    await sql.prepare("INSERT INTO managed_session_events VALUES ('ws','s','new','user.message',?,0)").bind(document("new",5,0)).run();
    await sql.exec("UPDATE managed_sessions SET revision=5");
    expect(await store.read({claim,after,limit:2})).toMatchObject({type:"page",rows:[{event:{id:"new"},position:{revision:5,index:0}}],hasMore:false});
  });
  it("keeps stable turn identity independent of Work claim attempts",async()=>{
    const {sql,store,input}=await fixture(d1);
    const expectedDocument=JSON.stringify({...JSON.parse(input.expectedDocument),source_position:{revision:2,index:0,execution_id:"stable-turn"}});
    await sql.prepare("UPDATE managed_session_events SET document=? WHERE id='z'").bind(expectedDocument).run();
    await sql.exec("UPDATE managed_environment_work SET claim_generation=3,claim_worker_id='replacement'");
    expect(await store.consume({...input,claim:{...claim,generation:3,holder:"replacement"},turnId:"stable-turn",expectedDocument})).toEqual({type:"consumed",inputId:"z",turnId:"stable-turn",boundary:"before_dispatch"});
    expect(await sql.prepare("SELECT json_extract(document,'$.source_position.consumed_by_execution_id') AS consumer FROM managed_session_events WHERE id='z'").first()).toEqual({consumer:"stable-turn"});
  });
  it("rejects forged turn identity and non-dispatchable documents",async()=>{
    const {store,input}=await fixture(d1);
    expect(await store.consume({...input,turnId:"w:2"})).toEqual({type:"rejected"});
    for(const patch of [{processedAt:"2026-01-01T00:00:00Z"},{type:"agent.message"},{cancelled_at_ms:1},{deferredUntilToolResults:["tool"]},{_queued:true}])
      expect(await store.consume({...input,expectedDocument:JSON.stringify({...JSON.parse(input.expectedDocument),...patch})})).toEqual({type:"rejected"});
    for(const override of [{workspaceId:"foreign"},{sessionId:"foreign"},{environmentId:"foreign"},{workId:"foreign"},{generation:1},{holder:"foreign"}])
      expect(await store.consume({...input,claim:{...claim,...override}})).toEqual({type:"rejected"});
  });
  it("requires migration validation and refuses to omit bootstrap history",async()=>{
    const {sql,store}=await fixture(d1);
    expect(await new SqlWorkInputs(sql).read({claim,after:null,limit:2})).toEqual({type:"gap",reason:"source_position_validation_required"});
    await sql.prepare("INSERT INTO managed_session_initial_events VALUES ('ws','s',0,?)").bind(JSON.stringify({type:"user.message",content:[]})).run();
    expect(await store.read({claim,after:null,limit:2})).toEqual({type:"gap",reason:"bootstrap_ordered_reader_required"});
  });
  it("cannot skip legacy bootstrap by supplying a later cursor",async()=>{
    const {sql,store}=await fixture(d1);
    await sql.prepare("INSERT INTO managed_session_initial_events VALUES ('ws','s',0,?)").bind(JSON.stringify({type:"user.message",content:[]})).run();
    expect(await store.read({claim,after:{revision:4,index:0},limit:1})).toEqual({type:"gap",reason:"bootstrap_ordered_reader_required"});
  });
  it("rejects foreign and expired feed claims without exposing rows",async()=>{
    const {sql,store}=await fixture(d1);
    for(const override of [{workspaceId:"foreign"},{sessionId:"foreign"},{environmentId:"foreign"},{workId:"foreign"},{generation:1},{holder:"foreign"}])
      expect(await store.read({claim:{...claim,...override},after:null,limit:2})).toEqual({type:"rejected"});
    await sql.exec("UPDATE managed_environment_work SET claim_at=-88000");
    expect(await store.read({claim,after:null,limit:2})).toEqual({type:"rejected"});
  });
  it("rolls back after input CAS loses between preparation and transaction",async()=>{
    const {sql,input}=await fixture(d1);
    const mutate=()=>sql.prepare("UPDATE managed_session_events SET document=json_set(document,'$.source_position.consumed_by_execution_id','racer') WHERE id='z'").run();
    const raced:SqlClient={prepare:s=>sql.prepare(s),exec:s=>sql.exec(s),batch:async statements=>{await mutate();return sql.batch(statements);},
      ...(sql.batchChecked?{batchChecked:async(statements,validate)=>{await mutate();return sql.batchChecked!(statements,validate);}}:{})};
    expect(await new SqlWorkInputs(raced,{sourcePositionsValidated:true}).consume(input)).toEqual({type:"rejected"});
    expect(await sql.prepare("SELECT revision FROM managed_sessions").first()).toEqual({revision:4});
    expect(await sql.prepare("SELECT json_extract(document,'$.source_position.consumed_by_execution_id') AS consumer FROM managed_session_events WHERE id='z'").first()).toEqual({consumer:"racer"});
  });
  it("seeks using the source index without a temporary sort",async()=>{
    const {sql}=await fixture(d1);
    // Capture the actual production reader's statements, not a copied query.
    const plans:string[]=[];
    const inspect:SqlClient={prepare:text=>{if(text.startsWith("SELECT document FROM managed_session_events"))plans.push(text);return sql.prepare(text);},exec:text=>sql.exec(text),batch:statements=>sql.batch(statements)};
    await new SqlWorkInputs(inspect,{sourcePositionsValidated:true}).read({claim,after:{revision:2,index:0},limit:1});
    expect(plans).toHaveLength(2);
    for(const [i,text] of plans.entries()) {
      const plan=await sql.prepare("EXPLAIN QUERY PLAN "+text).bind(...(i===0?["ws","s",2,0,2]:["ws","s",2,2])).all<{detail:string}>();
      expect(plan.results?.some(r=>r.detail.includes("SEARCH")&&r.detail.includes("managed_session_events_source_position"))).toBe(true);
      expect(plan.results?.map(r=>r.detail).join(" ")).toContain(">?");
      expect(plan.results?.some(r=>r.detail.includes("TEMP B-TREE"))).toBe(false);
    }
  });
  it("consumes only the exact input and does not treat a repeat as a durable receipt",async()=>{
    const {store,sql,input}=await fixture(d1);
    expect(await store.consume(input)).toEqual({type:"consumed",inputId:"z",turnId:"z",boundary:"before_dispatch"});
    expect(await store.consume(input)).toEqual({type:"gap",reason:"consumption_receipt_not_persisted"});
    expect(await sql.prepare("SELECT document FROM managed_session_events WHERE id='later'").first()).toEqual({document:document("later",4,0)});
    expect(await sql.prepare("SELECT revision FROM managed_sessions").first()).toEqual({revision:5});
  });
  for(const [name, mutation] of [
    ["old claim","UPDATE managed_environment_work SET claim_generation=3"],
    ["expired claim","UPDATE managed_environment_work SET claim_at=-88000"],
    ["wrong holder","UPDATE managed_environment_work SET claim_worker_id='other'"],
    ["wrong environment","UPDATE managed_sessions SET environment_id='other'"],
    ["stopped Work","UPDATE managed_environment_work SET state='stopped'"],
    ["archived Session","UPDATE managed_sessions SET archived_at=1"],
  ]) it("rejects "+name+" atomically",async()=>{
    const {store,sql,input}=await fixture(d1);await sql.exec(mutation!);
    expect(await store.consume(input)).toEqual({type:"rejected"});
    expect(await sql.prepare("SELECT document FROM managed_session_events WHERE id='z'").first()).toEqual({document:input.expectedDocument});
    expect(await sql.prepare("SELECT revision FROM managed_sessions").first()).toEqual({revision:4});
  });
  it("rolls back consumption when final Session CAS refuses",async()=>{
    const {store,sql,input}=await fixture(d1);
    await sql.prepare("CREATE TRIGGER refuse_revision BEFORE UPDATE ON managed_sessions WHEN NEW.revision > OLD.revision BEGIN SELECT RAISE(IGNORE); END").run();
    expect(await store.consume(input)).toEqual({type:"rejected"});
    expect(await sql.prepare("SELECT document FROM managed_session_events WHERE id='z'").first()).toEqual({document:input.expectedDocument});
  });
  it("rejects changed raw input, another consumer, and cross scope",async()=>{
    const {store,sql,input}=await fixture(d1);
    expect(await store.consume({...input,expectedDocument:input.expectedDocument+' '})).toEqual({type:"rejected"});
    expect(await store.consume({...input,claim:{...claim,workspaceId:"foreign"}})).toEqual({type:"rejected"});
    await sql.exec("UPDATE managed_session_events SET document=json_set(document,'$.source_position.consumed_by_execution_id','other') WHERE id='z'");
    expect(await store.consume(input)).toEqual({type:"rejected"});
  });
  for(const boundary of ["after_acceptance","acceptance_unknown"] as const) it("does not invent durable "+boundary+" receipts",async()=>{
    const {store,sql,input}=await fixture(d1);
    expect(await store.consume({...input,boundary})).toEqual({type:"gap",reason:"acceptance_receipt_not_persisted"});
    expect(await sql.prepare("SELECT document FROM managed_session_events WHERE id='z'").first()).toEqual({document:input.expectedDocument});
  });
});

it("MySQL cannot consume before a validated indexed schema (never falls back to a scan)",async()=>{
  const calls:string[]=[];
  const sql:SqlClient={prepare:text=>{calls.push(text);return {bind(){return this;},first:async()=>null,all:async()=>({results:[]}),run:async()=>({meta:{changes:0}})};},batch:async()=>[],exec:async()=>{}};
  const store=new SqlWorkInputs(sql,{dialect:"mysql",sourcePositionsValidated:true});
  expect(await store.read({claim,after:null,limit:1})).toEqual({type:"gap",reason:"source_position_index_required"});
  expect(calls.some(s=>s.includes("information_schema.statistics"))).toBe(true);
});
it("MySQL locks with SELECT FOR UPDATE rather than zero-change no-op UPDATE and uses byte-exact CAS",async()=>{
  const statements:string[]=[];
  const raw=document("z",2,0);
  const sql:SqlClient={prepare:text=>{statements.push(text);return {bind(){return this;},first:async()=>({revision:4,document:raw}) as never,
    all:async()=>({results: text.includes("information_schema.statistics") ? [
      {name:"managed_session_events_source_position",columns:"workspace_id,session_id,work_input_revision,work_input_index",non_unique:0},
      {name:"managed_session_events_source_position_invalid",columns:"workspace_id,session_id,work_input_invalid",non_unique:1},
      {name:"managed_session_initial_events_source_position_invalid",columns:"workspace_id,session_id,work_input_invalid",non_unique:1},
    ] as never : []}),run:async()=>({meta:{changes:0}})};},batch:async()=>[],exec:async()=>{},batchChecked:async(stmts,validate)=>{
      const results=[{results:[{revision:4}],meta:{changes:0}},{results:[{id:"w"}],meta:{changes:0}},{results:[{id:"z"}],meta:{changes:0}},{meta:{changes:1}},{meta:{changes:1}}] as never;
      validate(results);return results;
    }};
  const result=await new SqlWorkInputs(sql,{dialect:"mysql",sourcePositionsValidated:true,}).consume({claim,inputId:"z",turnId:"z",expectedDocument:raw,boundary:"before_dispatch"});
  expect(result).toEqual({type:"consumed",inputId:"z",turnId:"z",boundary:"before_dispatch"});
  expect(statements.filter(s=>s.endsWith("FOR UPDATE"))).toHaveLength(3);
  expect(statements.some(s=>s.includes("BINARY document=BINARY ?"))).toBe(true);
  const final=statements.at(-1)!;
  expect(final).toContain("UPDATE managed_sessions SET revision=revision+1");
  expect(final).toContain("UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))");
  const update=statements.find(s=>s.startsWith("UPDATE managed_session_events"))!;
  expect(update).toContain("UTC_TIMESTAMP(3)");
  expect(statements.indexOf(update)).toBeGreaterThan(statements.findIndex(s=>s.startsWith("SELECT id FROM managed_session_events")&&s.endsWith("FOR UPDATE")));
});
it("MySQL migration refuses legacy canonical rows before issuing additive DDL",async()=>{
 const {ensureMysqlWorkInputsSchema}=await import("../src/work-inputs");
 expect(typeof ensureMysqlWorkInputsSchema).toBe("function");
 const ddl:string[]=[];
 const sql:SqlClient={prepare:()=>({bind(){return this;},first:async()=>({present:1}) as never,all:async()=>({results:[]}),run:async()=>({meta:{changes:0}})}),batch:async()=>[],exec:async text=>{ddl.push(text);}};
 await expect(ensureMysqlWorkInputsSchema(sql)).rejects.toThrow(/source.position.*legacy/i);
 expect(ddl).toEqual([]);
});
for(const d1 of [false,true]) it(`same acceptance batch consumes atomically under one root (${d1?"D1":"SQLite"})`,async()=>{
 const f=await fixture(d1);const batch={rootId:"z",ids:["z","a"]};
 for(const id of batch.ids){const row=await f.sql.prepare("SELECT document FROM managed_session_events WHERE id=?").bind(id).first<{document:string}>();const raw=JSON.parse(row!.document);raw.source_position.input_batch=batch;await f.sql.prepare("UPDATE managed_session_events SET document=? WHERE id=?").bind(JSON.stringify(raw),id).run();}
 const root=(await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='z'").first<{document:string}>())!.document;
 expect(await f.store.consume({...f.input,expectedDocument:root})).toMatchObject({type:"consumed"});
 for(const id of batch.ids){const raw=JSON.parse((await f.sql.prepare("SELECT document FROM managed_session_events WHERE id=?").bind(id).first<{document:string}>())!.document);expect(raw.source_position.consumed_by_execution_id).toBe("z");expect(raw.source_position.consumption_claim).toEqual({workId:"w",generation:2,holder:"worker"});expect(raw.processedAt).toEqual(expect.any(String));}
 expect(JSON.parse((await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='later'").first<{document:string}>())!.document).processedAt).toBeNull();
 expect(await f.store.consume({...f.input,expectedDocument:root})).not.toMatchObject({type:"consumed"});
});
for(const mode of ["raw","lane","revision","ttl"] as const) it(`batch rejects ${mode} conflict without partially consuming root`,async()=>{
 const f=await fixture(false);const batch={rootId:"z",ids:["z","a"]};
 for(const id of batch.ids){const row=await f.sql.prepare("SELECT document FROM managed_session_events WHERE id=?").bind(id).first<{document:string}>();const raw=JSON.parse(row!.document);raw.source_position.input_batch=batch;if(id==="a"&&mode==="lane")raw.sessionThreadId="other";if(id==="a"&&mode==="revision")raw.source_position.revision=3;await f.sql.prepare("UPDATE managed_session_events SET document=? WHERE id=?").bind(JSON.stringify(raw),id).run();}
 const root=(await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='z'").first<{document:string}>())!.document;
 const mutate=async()=>{if(mode==="raw")await f.sql.exec("UPDATE managed_session_events SET document=document||' ' WHERE id='a'");if(mode==="ttl")await f.sql.exec("UPDATE managed_environment_work SET claim_at=0");};
 const raced:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:async statements=>{await mutate();return f.sql.batch(statements);},...(f.sql.batchChecked?{batchChecked:async(statements,validate)=>{await mutate();return f.sql.batchChecked!(statements,validate);}}:{})};
 expect(await new SqlWorkInputs(raced,{sourcePositionsValidated:true}).consume({...f.input,expectedDocument:root})).toEqual({type:"rejected"});expect((await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='z'").first<{document:string}>())!.document).toBe(root);
});

it.each(["null", "duplicate", "missing", "processed", "queued", "deferred", "cancelled"])("rejects malformed or non-dispatchable batch member (%s) without consuming its root", async mode => {
 const f=await fixture(false);
 const batch={rootId:"z",ids:mode==="duplicate"?["z","a","a"]:mode==="missing"?["z","missing"]:["z","a"]};
 for(const id of ["z","a"]){
  const row=await f.sql.prepare("SELECT document FROM managed_session_events WHERE id=?").bind(id).first<{document:string}>();
  const raw=JSON.parse(row!.document);
  raw.source_position.input_batch=mode==="null"?null:batch;
  if(id==="a"){
   if(mode==="processed")raw.processedAt="2026-11-11T00:00:00Z";
   if(mode==="queued")raw._queued=true;
   if(mode==="deferred")raw.deferredUntilToolResults=["tool"];
   if(mode==="cancelled")raw.cancelled_at_ms=1;
  }
  await f.sql.prepare("UPDATE managed_session_events SET document=? WHERE id=?").bind(JSON.stringify(raw),id).run();
 }
 const root=(await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='z'").first<{document:string}>())!.document;
 expect(await f.store.consume({...f.input,expectedDocument:root})).toEqual({type:"rejected"});
 expect((await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='z'").first<{document:string}>())!.document).toBe(root);
 expect(await f.sql.prepare("SELECT revision FROM managed_sessions").first()).toEqual({revision:4});
});
