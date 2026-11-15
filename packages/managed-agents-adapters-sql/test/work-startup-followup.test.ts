import {afterAll,expect,it} from "vitest";
import {createRequire} from "node:module";
import {createBetterSqlite3SqlClient,type SqlClient} from "@open-managed-agents/sql-client";
import {CfD1SqlClient} from "@open-managed-agents/sql-client/adapters/cf-d1";
import {SqlSessionRuntimeProjectionPersistence} from "../src/session-runtime-projection-sql-persistence";
const claim={workspaceId:"ws",environmentId:"env",sessionId:"s",workId:"w",generation:2};
async function fixture(client?:SqlClient){
 const sql=client??await createBetterSqlite3SqlClient(":memory:");
 await sql.exec(`CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,document TEXT,revision INTEGER,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,environment_id TEXT,agent_id TEXT,agent_version INTEGER,deployment_id TEXT,status TEXT,PRIMARY KEY(workspace_id,id));
 CREATE TABLE managed_environment_work(workspace_id TEXT,environment_id TEXT,id TEXT,session_id TEXT,state TEXT,claim_generation INTEGER,claim_at INTEGER,heartbeat_ttl_seconds INTEGER,revision INTEGER,document TEXT,claim_worker_id TEXT,created_at INTEGER,PRIMARY KEY(workspace_id,id));
 CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,thread_id TEXT,id TEXT,type TEXT,document TEXT,processed_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));
 CREATE TABLE managed_session_initial_events(workspace_id TEXT,session_id TEXT,sequence INTEGER,document TEXT,PRIMARY KEY(workspace_id,session_id,sequence));`);
 const now=new Date().toISOString();const session={id:"s",agent:{id:"a",version:1},status:"idle",environmentId:"env",archivedAt:null,updatedAt:now,budget:null,usage:{},outcomeEvaluations:[]};
 await sql.prepare("INSERT INTO managed_sessions VALUES ('ws','s',?,4,0,0,NULL,'env','a',1,NULL,'idle')").bind(JSON.stringify(session)).run();
 await sql.prepare("INSERT INTO managed_environment_work VALUES ('ws','env','w','s','active',2,?,90,3,'{}','new-holder',0)").bind(Date.now()).run();
 const add=async(id:string,event:object,revision:number,source:object={})=>sql.prepare("INSERT INTO managed_session_events VALUES ('ws','s',NULL,?,?,?,0)").bind(id,(event as {type:string}).type,JSON.stringify({id,processedAt:now,...event,source_position:{revision,index:0,...source}})).run();
 await add("old",{type:"user.message",content:[]},1,{consumed_by_execution_id:"old",consumption_claim:{workId:"w",generation:1,holder:"old-holder"}});
 await add("done",{type:"session.status_idle",stopReason:{type:"end_turn"}},2,{execution_id:"old",environment_work:{workId:"w",generation:1}});
 await add("followup",{type:"user.message",content:[],processedAt:null},4,{execution_id:"next-turn"});
 return {sql,add,now,persistence:new SqlSessionRuntimeProjectionPersistence(sql)};
}
it("captures run-authorized reclaimed followup without forging running or consuming root",async()=>{
 const f=await fixture();const before=await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='followup'").first();
 expect(await f.persistence.captureStartupBoundary(claim)).toBe(4);
 expect(await f.sql.prepare("SELECT status,revision FROM managed_sessions").first()).toEqual({status:"idle",revision:4});
 expect(await f.sql.prepare("SELECT document FROM managed_session_events WHERE id='followup'").first()).toEqual(before);
});
it.each(["empty","consumed","parked","budget","stopping","expired","no-holder","archived"])("idle %s is not blanket startup permission",async kind=>{
 const f=await fixture();
 const changes:Record<string,string>={empty:"DELETE FROM managed_session_events WHERE id='followup'",consumed:"UPDATE managed_session_events SET document=json_set(document,'$.processedAt','2026-11-11T00:00:00Z','$.source_position.consumed_by_execution_id','next-turn') WHERE id='followup'",parked:"UPDATE managed_session_events SET document=json_set(document,'$.stopReason',json('{\"type\":\"requires_action\",\"eventIds\":[\"call\"]}')) WHERE id='done'",budget:"UPDATE managed_sessions SET document=json_set(document,'$.budget',json('{\"amountMinor\":\"1\",\"currency\":\"USD\"}'),'$.usage',json('{\"listCost\":{\"amountMinor\":\"1\",\"currency\":\"USD\"}}'))",stopping:"UPDATE managed_environment_work SET state='stopping'",expired:"UPDATE managed_environment_work SET claim_at=0","no-holder":"UPDATE managed_environment_work SET claim_worker_id=NULL",archived:"UPDATE managed_sessions SET archived_at=1"};
 await f.sql.exec(changes[kind]!);expect(await f.persistence.captureStartupBoundary(claim)).toBeNull();
});
it.each([{...claim,workspaceId:"foreign"},{...claim,sessionId:"foreign"},{...claim,environmentId:"foreign"},{...claim,workId:"foreign"},{...claim,generation:1}])("rejects wrong canonical scope %j",async c=>{const f=await fixture();expect(await f.persistence.captureStartupBoundary(c)).toBeNull();});
it.each(["UPDATE managed_sessions SET revision=5","UPDATE managed_environment_work SET claim_generation=3","UPDATE managed_environment_work SET claim_worker_id='replacement'","UPDATE managed_environment_work SET claim_at=0","UPDATE managed_session_events SET document=json_set(document,'$.content',json('[{\"type\":\"text\",\"text\":\"changed\"}]')) WHERE id='followup'"])("checks final raw-root/claim/revision CAS after selecting idle followup: %s",async change=>{
 const f=await fixture();let injected=false;
 const sql:SqlClient={prepare:query=>{const s=f.sql.prepare(query);const wrap=(statement:typeof s):typeof s=>({bind:(...args)=>wrap(statement.bind(...args)),first:()=>statement.first(),all:()=>statement.all(),run:async()=>{if(!injected&&query.includes("UPDATE managed_sessions")){injected=true;await f.sql.exec(change);}return statement.run();}});return wrap(s);},exec:q=>f.sql.exec(q),batch:ss=>f.sql.batch(ss)};
 expect(await new SqlSessionRuntimeProjectionPersistence(sql).captureStartupBoundary(claim)).toBeNull();expect(injected).toBe(true);
});
it("idle followup startup failure exhausts only captured pending root under existing atomic stop CAS",async()=>{
 const f=await fixture();expect(await f.persistence.captureStartupBoundary(claim)).toBe(4);
 expect(await f.persistence.settleStartupFailure({claim,revision:4,processedAt:f.now})).toBe("committed");
 expect(await f.sql.prepare("SELECT state FROM managed_environment_work").first()).toEqual({state:"stopped"});
 expect(await f.persistence.settleStartupFailure({claim,revision:4,processedAt:f.now})).toBe("committed");
});
it("new input after idle startup boundary rejects failure settlement",async()=>{
 const f=await fixture();expect(await f.persistence.captureStartupBoundary(claim)).toBe(4);await f.add("later",{type:"user.message",content:[],processedAt:null},5);await f.sql.exec("UPDATE managed_sessions SET revision=5");
 expect(await f.persistence.settleStartupFailure({claim,revision:4,processedAt:f.now})).toBe("rejected");
});
const instances:Array<{dispose():Promise<void>}>=[];afterAll(async()=>{for(const mf of instances)await mf.dispose();});
it("real D1 captures precise idle followup and never changes its status",async()=>{
 const require=createRequire(import.meta.url);const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve("wrangler/package.json"))("miniflare");const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:"2026-11-01",d1Databases:["DB"]}));instances.push(mf);
 const f=await fixture(new CfD1SqlClient(await mf.getD1Database("DB")));expect(await f.persistence.captureStartupBoundary(claim)).toBe(4);expect(await f.sql.prepare("SELECT status FROM managed_sessions").first()).toEqual({status:"idle"});
});
it("lost holder at idle startup failure CAS cannot append or stop the new owner",async()=>{
 const f=await fixture();expect(await f.persistence.captureStartupBoundary(claim)).toBe(4);let injected=false;
 const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:ss=>f.sql.batch(ss),batchChecked:async(ss,validate)=>{if(!injected){injected=true;await f.sql.exec("UPDATE managed_environment_work SET claim_worker_id='replacement'");}return f.sql.batchChecked!(ss,validate);}};
 expect(await new SqlSessionRuntimeProjectionPersistence(sql).settleStartupFailure({claim,revision:4,processedAt:f.now})).toBe("rejected");
 expect(await f.sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE type='session.error'").first()).toEqual({n:0});
 expect(await f.sql.prepare("SELECT state FROM managed_environment_work").first()).toEqual({state:"active"});
});
it("consumption after idle boundary prevents startup failure from reclassifying a dispatched turn",async()=>{
 const f=await fixture();expect(await f.persistence.captureStartupBoundary(claim)).toBe(4);
 await f.sql.exec("UPDATE managed_session_events SET document=json_set(document,'$.processedAt','2026-11-11T00:00:00Z','$.source_position.consumed_by_execution_id','next-turn') WHERE id='followup';UPDATE managed_sessions SET revision=5");
 expect(await f.persistence.settleStartupFailure({claim,revision:4,processedAt:f.now})).toBe("rejected");
});
it("idle snapshot root raw bytes cannot authorize another input after late mutation in settlement",async()=>{
 const f=await fixture();let injected=false;
 const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:ss=>f.sql.batch(ss),batchChecked:async(ss,validate)=>{if(!injected){injected=true;await f.sql.exec("UPDATE managed_session_events SET document=json_set(document,'$.content',json('[{\"type\":\"text\",\"text\":\"other\"}]')) WHERE id='followup'");}return f.sql.batchChecked!(ss,validate);}};
 expect(await new SqlSessionRuntimeProjectionPersistence(sql).settleStartupFailure({claim,revision:4,processedAt:f.now})).toBe("rejected");
 expect(await f.sql.prepare("SELECT revision,status FROM managed_sessions").first()).toEqual({revision:4,status:"idle"});
});
it("D1 idle startup failure rolls back terminal if final Work stop loses its CAS",async()=>{
 const require=createRequire(import.meta.url);const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve("wrangler/package.json"))("miniflare");const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:"2026-11-01",d1Databases:["DB"]}));instances.push(mf);
 const f=await fixture(new CfD1SqlClient(await mf.getD1Database("DB")));
 await f.sql.prepare("CREATE TRIGGER refuse_work_stop BEFORE UPDATE ON managed_environment_work WHEN NEW.state='stopped' BEGIN SELECT RAISE(IGNORE); END").run();
 expect(await f.persistence.settleStartupFailure({claim,revision:4,processedAt:f.now})).toBe("rejected");
 expect(await f.sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE type='session.error'").first()).toEqual({n:0});expect(await f.sql.prepare("SELECT revision,status FROM managed_sessions").first()).toEqual({revision:4,status:"idle"});
});
it.each(['{broken','null','[]','{"id":"followup","type":"user.message","processedAt":null,"source_position":{"revision":4,"index":0},"content":null}'])("malformed idle root fails closed with typed result: %s",async document=>{
 const f=await fixture();await f.sql.prepare("UPDATE managed_session_events SET document=? WHERE id='followup'").bind(document).run();
 expect(await f.persistence.captureStartupBoundary(claim)).toBeNull();
 expect(await f.persistence.settleStartupFailure({claim,revision:4,processedAt:f.now})).toBe("rejected");
});
it.each(["postgres","mysql"] as const)("production composition forwards %s startup dialect (SQL contract, not live server)",async dialect=>{
 const f=await fixture();const queries:string[]=[];
 const sql:SqlClient={prepare:q=>{queries.push(q);if(q.includes("UPDATE managed_sessions SET revision=revision")){
  // Do not execute non-SQLite syntax on SQLite. Observe the emitted statement
  // and return an explicit refused CAS; other reads use the real database.
  const statement={bind:()=>statement,first:async()=>null,all:async()=>({results:[],meta:{changes:0}}),run:async()=>({meta:{changes:0}})};return statement;
 }return f.sql.prepare(q);},exec:q=>f.sql.exec(q),batch:ss=>f.sql.batch(ss)};
 const {SqlManagedSessionsComposition}=await import("../src/managed-sessions-composition");
 const {admitAllSessionCreates}=await import("@open-managed-agents/managed-agents-application");
 const composition=new SqlManagedSessionsComposition({client:sql,workInputs:{sourcePositionsValidated:true,dialect},environments:{find:async()=>null},admission:admitAllSessionCreates,
 lifecycle:{sessionStarted:async()=>{},sessionStopped:async()=>{}},runtime:{sessionEventsAccepted:async()=>{},sessionThreadArchived:async()=>{},async *subscribe(){}},
 sealer:{seal:async value=>value},clock:{now:()=>new Date()},ids:{nextEventId:()=>"e",nextSessionId:()=>"s",nextOutcomeId:()=>"o",nextResourceId:()=>"r"}});
 expect(await composition.runtimeProjection.captureStartupBoundary(claim)).toBeNull();
 const cas=queries.find(q=>q.includes("UPDATE managed_sessions SET revision=revision"))!;
 expect(cas).not.toContain("strftime");expect(cas).toContain(dialect==="postgres"?"clock_timestamp()":"CURRENT_TIMESTAMP(3)");
 if(dialect==="mysql")expect(cas).toContain("BINARY document=BINARY ?");
});
it("malformed canonical JSON yields HTTP409 rather than unavailable503, without hiding SQL outages",async()=>{
 const f=await fixture();await f.sql.prepare("UPDATE managed_session_events SET document=? WHERE id='followup'").bind('{bad').run();
 const {buildWorkStartupFailureRoutes}=await import("../../http-routes/src/work-startup-failure");
 const route=buildWorkStartupFailureRoutes({authenticate:async()=>claim,persistenceFor:async()=>f.persistence});
 const response=await route.request('/s/startup-boundary',{method:'POST',headers:{authorization:'Bearer work'}});expect(response.status).toBe(409);
 await f.sql.exec("DROP TABLE managed_session_events");
 const unavailable=await route.request('/s/startup-boundary',{method:'POST',headers:{authorization:'Bearer work'}});expect(unavailable.status).toBe(503);
});
