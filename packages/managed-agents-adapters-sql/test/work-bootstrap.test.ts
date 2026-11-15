import { createRequire } from "node:module";
import { afterAll, expect, it } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import * as adapters from "../src/index";
import * as application from "../../managed-agents-application/src/index";
import { SqlWorkFinalization } from "../src/work-finalization";
const now = "2026-11-10T00:00:00.000Z";
const claim={workspaceId:"ws",environmentId:"env",sessionId:"s",workId:"w",generation:2,holder:"worker"};
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
 return {sql,insert};
}

function bootstrap(sql:SqlClient){
 expect(typeof adapters.SqlWorkBootstrap).toBe("function");
 return new application.WorkBootstrapApplication({persistence:new adapters.SqlWorkBootstrap(sql),finalization:new SqlWorkFinalization(sql)});
}
it("reads claim-backed run then unknown root then cleanup-only without mutating input or Work",async()=>{
 const f=await fixture();await f.insert({id:"first",type:"user.message",processedAt:null,content:[]},2);
 expect(await bootstrap(f.sql).read(claim)).toEqual({type:"run",claim,revision:3,root:{inputId:"first",turnId:"first",position:{revision:2,index:0}}});
 await f.sql.exec("UPDATE managed_session_events SET document=json_set(document,'$.source_position.consumed_by_execution_id','first','$.processedAt','2026-11-10T00:00:00Z');UPDATE managed_sessions SET revision=4");
 expect(await bootstrap(f.sql).read(claim)).toMatchObject({type:"gap",reason:"consumed_turn_without_terminal",root:{turnId:"first"}});
 await f.insert({id:"terminal",type:"session.status_idle",processedAt:now,stopReason:{type:"end_turn"}},5,{execution_id:"first",environment_work:{workId:"w",generation:1}});await f.sql.exec("UPDATE managed_sessions SET revision=5");
 expect(await bootstrap(f.sql).read(claim)).toMatchObject({type:"cleanup-only",claim,revision:5,root:{turnId:"first"},terminal:{eventId:"terminal",generation:1}});
 expect(await f.sql.prepare("SELECT state,claim_generation FROM managed_environment_work").first()).toEqual({state:"active",claim_generation:2});
});
it("empty resident Work returns idle; stale holder, generation, TTL and environment refuse",async()=>{
 const f=await fixture();expect(await bootstrap(f.sql).read(claim)).toEqual({type:"idle",claim,revision:3,root:null});
 for(const other of [{...claim,holder:"other"},{...claim,generation:1},{...claim,environmentId:"other"},{...claim,sessionId:"other"}])expect(await bootstrap(f.sql).read(other)).toMatchObject({type:"rejected"});
 await f.sql.exec("UPDATE managed_environment_work SET claim_at=0");expect(await bootstrap(f.sql).read(claim)).toMatchObject({type:"rejected"});
});
it.each(["UPDATE managed_sessions SET revision=revision+1","UPDATE managed_environment_work SET claim_generation=3","UPDATE managed_environment_work SET claim_worker_id='new'","UPDATE managed_environment_work SET claim_at=0","UPDATE managed_environment_work SET state='stopping'"])("fences snapshot races before even an idle response: %s",async change=>{
 const f=await fixture();const store=new adapters.SqlWorkBootstrap(f.sql);
 const app=new application.WorkBootstrapApplication({persistence:{read:async c=>{const result=await store.read(c);await f.sql.exec(change);return result;},isCurrent:(c,r,state)=>store.isCurrent(c,r,state)},finalization:new SqlWorkFinalization(f.sql)});
 expect(await app.read(claim)).toMatchObject({type:"rejected"});
});
it("rejects source gaps instead of inferring order from row insertion or timestamps",async()=>{
 const f=await fixture();await f.sql.prepare("INSERT INTO managed_session_events VALUES ('ws','s',NULL,'legacy','user.message',?,0)").bind(JSON.stringify({id:"legacy",type:"user.message",processedAt:null,content:[]})).run();
 expect(await bootstrap(f.sql).read(claim)).toMatchObject({type:"gap",reason:"canonical_position_required"});
});
const disposals:Array<()=>Promise<void>>=[];afterAll(async()=>{for(const close of disposals)await close();});
it("real D1 bootstrap uses canonical initial row and rereads expiry/revision",async()=>{
 const require=createRequire(import.meta.url);const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve("wrangler/package.json"))("miniflare");
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:"2026-11-01",d1Databases:["DB"]}));disposals.push(()=>mf.dispose());
 const f=await fixture(new CfD1SqlClient(await mf.getD1Database("DB")));
 await f.sql.prepare("INSERT INTO managed_session_initial_events VALUES ('ws','s',0,?)").bind(JSON.stringify({id:"bootstrap_s:0",type:"user.message",processedAt:null,content:[],source_position:{revision:1,index:0}})).run();
 expect(await bootstrap(f.sql).read(claim)).toMatchObject({type:"run",claim,root:{turnId:"bootstrap_s:0",position:{revision:1,index:0}}});
 const store=new adapters.SqlWorkBootstrap(f.sql);const read=await store.read(claim);expect(read.type).toBe("snapshot");
 await f.sql.exec("UPDATE managed_sessions SET revision=revision+1");expect(await store.isCurrent(claim,3)).toBe(false);
 await f.sql.exec("UPDATE managed_environment_work SET claim_at=0");expect(await bootstrap(f.sql).read(claim)).toMatchObject({type:"rejected"});
});
it("multiple pending roots admit the earliest root without consuming or skipping its successor",async()=>{
 const f=await fixture();await f.insert({id:"earlier",type:"user.message",processedAt:null,content:[]},2);await f.insert({id:"later",type:"user.message",processedAt:null,content:[]},3);
 const before=await f.sql.prepare("SELECT document FROM managed_session_events ORDER BY id").all();
 expect(await bootstrap(f.sql).read(claim)).toMatchObject({type:"run",root:{turnId:"earlier"},revision:3});
 expect(await f.sql.prepare("SELECT document FROM managed_session_events ORDER BY id").all()).toEqual(before);
});
it("new input during finalization inspection invalidates a run plan",async()=>{
 const f=await fixture();await f.insert({id:"root",type:"user.message",processedAt:null,content:[]},2);
 const finalization=new SqlWorkFinalization(f.sql);
 const app=new application.WorkBootstrapApplication({persistence:new adapters.SqlWorkBootstrap(f.sql),finalization:{inspect:async request=>{
  const state=await finalization.inspect(request);await f.insert({id:"new",type:"user.message",processedAt:null,content:[]},4);await f.sql.exec("UPDATE managed_sessions SET revision=4");return state;
 }}});
 expect(await app.read(claim)).toEqual({type:"rejected",reason:"authority_changed"});
});
it("stopping Work permits exact cleanup but never idle or model admission",async()=>{
 const f=await fixture();await f.sql.exec("UPDATE managed_environment_work SET state='stopping'");
 expect(await bootstrap(f.sql).read(claim)).toMatchObject({type:"rejected",reason:"work_stopping"});
 await f.insert({id:"root",type:"user.message",processedAt:now,content:[]},2,{consumed_by_execution_id:"root"});
 await f.insert({id:"terminal",type:"session.status_idle",processedAt:now,stopReason:{type:"end_turn"}},3,{execution_id:"root",environment_work:{workId:"w",generation:2}});
 expect(await bootstrap(f.sql).read(claim)).toMatchObject({type:"cleanup-only",terminal:{turnId:"root"}});
});
