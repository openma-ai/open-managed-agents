import {expect,it} from "vitest";
import {createBetterSqlite3SqlClient} from "@open-managed-agents/sql-client";
import {SessionRuntimeProjectionApplicationService} from "@open-managed-agents/managed-agents-application";
import {SqlSessionRuntimeProjectionPersistence} from "../src/session-runtime-projection-sql-persistence";
import {SqlWorkModelEgress} from "../src/work-model-egress";

it("shares persisted domain list cost between two independent proxy meters and fences an old claim", async()=>{
 const sql=await createBetterSqlite3SqlClient(":memory:");
 await sql.exec("CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,document TEXT,revision INTEGER,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,environment_id TEXT,agent_id TEXT,agent_version INTEGER,deployment_id TEXT,status TEXT,PRIMARY KEY(workspace_id,id)); CREATE TABLE managed_environment_work(workspace_id TEXT,environment_id TEXT,id TEXT,session_id TEXT,state TEXT,claim_generation INTEGER,claim_at INTEGER,heartbeat_ttl_seconds INTEGER,revision INTEGER,document TEXT,PRIMARY KEY(workspace_id,id)); CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,thread_id TEXT,id TEXT,type TEXT,document TEXT,processed_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));");
 const session={id:"s",agent:{id:"a",version:1},environmentId:"e",status:"running",budget:{amountMinor:"1",currency:"USD"},usage:{},updatedAt:new Date().toISOString(),archivedAt:null};
 await sql.prepare("INSERT INTO managed_sessions VALUES ('w','s',?,3,0,0,NULL,'e','a',1,NULL,'running')").bind(JSON.stringify(session)).run();
 await sql.prepare("INSERT INTO managed_environment_work VALUES ('w','e','work','s','active',1,?,90,1,'{}')").bind(Date.now()).run();
 const claim={workspaceId:"w",environmentId:"e",sessionId:"s",workId:"work",generation:1};
 const pricing={version:1 as const,currency:"USD" as const,input_per_mtok:"1",output_per_mtok:"1"};
 const a=new SqlWorkModelEgress(sql),b=new SqlWorkModelEgress(sql);
 const meterA=await a.open(claim,pricing),meterB=await b.open(claim,pricing);
 expect(await meterA!.begin()).toBe(true);
 await meterA!.complete({input_tokens:10000});
 expect(await meterB!.begin()).toBe(false);
 const runtime=new SessionRuntimeProjectionApplicationService({workspaceId:"w",persistence:new SqlSessionRuntimeProjectionPersistence(sql)});
 expect((await runtime.recordSessionRuntimeEvents({sessionId:"s",environmentWorkFence:claim,events:[{id:"runtime-usage",type:"session.usage",processedAt:new Date().toISOString(),usage:{inputTokens:1}}]})).type).toBe("recorded");
 expect(await meterB!.begin()).toBe(false);
 expect(JSON.parse((await sql.prepare("SELECT document FROM managed_sessions").first<{document:string}>())!.document).usage.list_cost_pico).toBe("10000000000");
 expect(await (await b.open(claim,null))!.begin()).toBe(true);
 await sql.exec("UPDATE managed_environment_work SET claim_generation=2");
 expect(await meterA!.begin()).toBe(false);
 await expect(meterA!.complete({input_tokens:1})).rejects.toThrow();
});

it("rebases concurrent completion deltas instead of losing replica usage",async()=>{
 const sql=await createBetterSqlite3SqlClient(":memory:");
 await sql.exec("CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,document TEXT,revision INTEGER,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,environment_id TEXT,agent_id TEXT,agent_version INTEGER,deployment_id TEXT,status TEXT,PRIMARY KEY(workspace_id,id)); CREATE TABLE managed_environment_work(workspace_id TEXT,environment_id TEXT,id TEXT,session_id TEXT,state TEXT,claim_generation INTEGER,claim_at INTEGER,heartbeat_ttl_seconds INTEGER,revision INTEGER,document TEXT,PRIMARY KEY(workspace_id,id)); CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,thread_id TEXT,id TEXT,type TEXT,document TEXT,processed_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));");
 const session={id:"s",agent:{id:"a",version:1},environmentId:"e",status:"running",budget:{amountMinor:"100",currency:"USD"},usage:{},updatedAt:new Date().toISOString(),archivedAt:null};
 await sql.prepare("INSERT INTO managed_sessions VALUES ('w','s',?,3,0,0,NULL,'e','a',1,NULL,'running')").bind(JSON.stringify(session)).run();
 await sql.prepare("INSERT INTO managed_environment_work VALUES ('w','e','work','s','active',1,?,90,1,'{}')").bind(Date.now()).run();
 const claim={workspaceId:"w",environmentId:"e",sessionId:"s",workId:"work",generation:1};
 const pricing={version:1 as const,currency:"USD" as const,input_per_mtok:"1",output_per_mtok:"1"};
 const a=await new SqlWorkModelEgress(sql).open(claim,pricing),b=await new SqlWorkModelEgress(sql).open(claim,pricing);
 await Promise.all([a.complete({input_tokens:100}),b.complete({input_tokens:200})]);
 const row=await sql.prepare("SELECT document FROM managed_sessions").first<{document:string}>();
 expect(JSON.parse(row!.document).usage).toMatchObject({inputTokens:300,list_cost_pico:"300000000"});
});
