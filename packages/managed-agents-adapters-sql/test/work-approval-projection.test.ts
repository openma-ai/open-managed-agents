import { URL } from "node:url";
import { afterAll, expect, it } from 'vitest';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createBetterSqlite3SqlClient,type SqlClient} from '../../sql-client/src/index';
import {CfD1SqlClient} from '../../sql-client/src/adapters/cf-d1';
import {SqlWorkInputs} from '../../managed-agents-adapters-sql/src/work-inputs';
import {SqlWorkFinalization} from '../../managed-agents-adapters-sql/src/work-finalization';
import {SqlSessionRuntimeProjectionPersistence} from '../../managed-agents-adapters-sql/src/session-runtime-projection-sql-persistence';
import {SessionRuntimeProjectionApplicationService} from '../../managed-agents-application/src/session-execution/application';
import {WorkFinalizationApplication} from '../../managed-agents-application/src/work-finalization/application';
import {createWorkPermissionBridge} from '../../harness-runtime-acp/src/work-permission-bridge';
import {ingestEnvironmentWorkRuntimeEvents} from '../../managed-agents-adapters-runtime/src/environment-work-runtime-ingress';
const closes:Array<()=>Promise<unknown>>=[];afterAll(async()=>{for(const close of closes)await close();});
const claim={workspaceId:'ws',environmentId:'env',sessionId:'s',workId:'w',generation:2,holder:'holder'};
const now='2026-11-10T00:00:00.000Z';
async function fixture(d1=false){
 let sql:SqlClient;
 if(d1){const require=createRequire(import.meta.url);const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve('wrangler/package.json'))('miniflare');const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:'2026-11-01',d1Databases:['DB']}));closes.push(()=>mf.dispose());sql=new CfD1SqlClient(await mf.getD1Database('DB'));}
 else sql=await createBetterSqlite3SqlClient(':memory:');
 await sql.exec(`CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,document TEXT,revision INTEGER,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,environment_id TEXT,agent_id TEXT,agent_version INTEGER,deployment_id TEXT,status TEXT,PRIMARY KEY(workspace_id,id));
 CREATE TABLE managed_session_threads(workspace_id TEXT,session_id TEXT,id TEXT,document TEXT,updated_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));
 CREATE TABLE managed_environment_work(workspace_id TEXT,environment_id TEXT,id TEXT,session_id TEXT,state TEXT,claim_generation INTEGER,claim_at INTEGER,heartbeat_ttl_seconds INTEGER,revision INTEGER,document TEXT,claim_worker_id TEXT,created_at INTEGER,PRIMARY KEY(workspace_id,id));
 CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,thread_id TEXT,id TEXT,type TEXT,document TEXT,processed_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));
 CREATE TABLE managed_session_initial_events(workspace_id TEXT,session_id TEXT,sequence INTEGER,document TEXT,PRIMARY KEY(workspace_id,session_id,sequence));`);
 for(const s of (await readFile(new URL('../../../apps/main-node/migrations-sqlite/0034_work_inputs.sql', import.meta.url),'utf8')).split('--> statement-breakpoint'))await sql.prepare(s).run();
 const session={id:'s',agent:{id:'agent',version:1,name:'Agent'},environmentId:'env',deploymentId:null,status:'running',createdAt:now,updatedAt:now,archivedAt:null,budget:null,usage:{},outcomeEvaluations:[]};
 await sql.prepare("INSERT INTO managed_sessions VALUES('ws','s',?,1,0,0,NULL,'env','agent',1,NULL,'running')").bind(JSON.stringify(session)).run();
 await sql.prepare("INSERT INTO managed_environment_work VALUES('ws','env','w','s','active',2,?,90,1,'{}','holder',0)").bind(Date.now()).run();
 const revision=async()=>(await sql.prepare("SELECT revision FROM managed_sessions WHERE id='s'").first<{revision:number}>())!.revision;
 const read=async(id:string)=>(await sql.prepare('SELECT document FROM managed_session_events WHERE id=?').bind(id).first<{document:string}>())!.document;
 const admit=async(event:Record<string,unknown>)=>{const r=await revision()+1;const raw=JSON.stringify({...event,source_position:{revision:r,index:0,execution_id:'dispatch-'+event.id}});await sql.prepare("INSERT INTO managed_session_events VALUES('ws','s',NULL,?,?,?,0)").bind(event.id,event.type,raw).run();await sql.prepare("UPDATE managed_sessions SET revision=? WHERE id='s'").bind(r).run();return raw;};
 const inputs=new SqlWorkInputs(sql,{sourcePositionsValidated:true});
 const raw=await admit({id:'root',type:'user.message',content:[],processedAt:null});
 expect(await inputs.consume({claim,inputId:'root',turnId:'dispatch-root',expectedDocument:raw,boundary:'before_dispatch'})).toMatchObject({type:'consumed'});
 const root={inputId:'root',turnId:'dispatch-root',expectedDocument:await read('root')};
 const projection=new SessionRuntimeProjectionApplicationService({workspaceId:'ws',persistence:new SqlSessionRuntimeProjectionPersistence(sql)});
 const send=(events:any[],proof:any=root)=>ingestEnvironmentWorkRuntimeEvents({claim,sessionId:'s',body:{events,root:proof},projection,publish:async()=>{}});
 const app=new WorkFinalizationApplication({persistence:new SqlWorkFinalization(sql),host:{prepare:async scope=>{expect(await scope.isCurrent()).toBe(true);return {type:'prepared'};},publish:async()=>({type:'published'})}});
 const recover=()=>app.recover({claim,turnId:root.turnId});
 const finalize=async()=>app.finalize({claim,turnId:root.turnId,revision:await revision(),stopReason:{type:'end_turn'}});
 const ask=async()=>{expect(await send([{id:'tool',type:'agent.tool_use',name:'bash',input:{command:'true'},evaluated_permission:'ask',processed_at:now},{id:'pause',type:'session.status_idle',stop_reason:{type:'requires_action',event_ids:['tool']},processed_at:now}])).toMatchObject({type:'recorded'});};
 return {sql,read,admit,inputs,root,send,app,recover,finalize,revision,ask};
}

for (const d1 of [false,true]) {
 it(`${d1?'D1':'SQLite'}: partial pause cannot hide an unanswered request or clear it in a later batch`,async()=>{
  const f=await fixture(d1);await f.ask();
  expect(await f.send([{id:'tool2',type:'agent.tool_use',name:'read',input:{},evaluated_permission:'ask',processed_at:now},{id:'pause2',type:'session.status_idle',stop_reason:{type:'requires_action',event_ids:['tool','tool2']},processed_at:now}])).toMatchObject({type:'recorded'});
  const before=await f.revision();
  for(const ids of [['tool'],['tool2']]) {
   expect((await f.send([{id:'shrink',type:'session.status_idle',stop_reason:{type:'requires_action',event_ids:ids},processed_at:now}])).type).not.toBe('recorded');
  }
  expect(await f.revision()).toBe(before);
  expect(await f.sql.prepare("SELECT id FROM managed_session_events WHERE id='shrink'").first()).toBeNull();
  const answer=await f.admit({id:'answer',type:'user.tool_confirmation',toolUseId:'tool',result:'deny',processedAt:null});
  expect(await f.inputs.consume({claim,inputId:'answer',turnId:'dispatch-answer',expectedDocument:answer,boundary:'before_dispatch',consumingTurnId:f.root.turnId,rootInputId:f.root.inputId,expectedRootDocument:f.root.expectedDocument})).toMatchObject({type:'consumed'});
  expect((await f.send([{id:'wrong-remainder',type:'session.status_idle',stop_reason:{type:'requires_action',event_ids:['tool']},processed_at:now}])).type).not.toBe('recorded');
  expect(await f.send([{id:'right-remainder',type:'session.status_idle',stop_reason:{type:'requires_action',event_ids:['tool2']},processed_at:now}])).toMatchObject({type:'recorded'});
  expect((await f.send([{id:'running',type:'session.status_running',processed_at:now}])).type).not.toBe('recorded');
  expect(await f.recover()).toMatchObject({type:'parked'});
 });
 it(`${d1?'D1':'SQLite'}: same-batch ask cannot immediately resume without user consumption`,async()=>{
  const f=await fixture(d1);const before=await f.revision();
  expect((await f.send([{id:'tool',type:'agent.tool_use',name:'read',input:{},evaluated_permission:'ask',processed_at:now},{id:'running',type:'session.status_running',processed_at:now}])).type).not.toBe('recorded');
  expect(await f.revision()).toBe(before);expect(await f.sql.prepare("SELECT id FROM managed_session_events WHERE id='tool'").first()).toBeNull();
 });
}
it('startup running without approval is preserved; runtime results never substitute for user approval',async()=>{
 const f=await fixture();expect(await f.send([{id:'startup',type:'session.status_running',processed_at:now}])).toMatchObject({type:'recorded'});
 await f.ask();expect(await f.send([{id:'tool-result',type:'agent.tool_result',tool_use_id:'tool',content:[],is_error:false,processed_at:now}])).toMatchObject({type:'recorded'});
 expect((await f.send([{id:'fake-result-running',type:'session.status_running',processed_at:now}])).type).not.toBe('recorded');
 expect(await f.sql.prepare("SELECT id FROM managed_session_events WHERE id='fake-result-running'").first()).toBeNull();
});
it('resolution proof cannot survive a Session revision race at the projection transaction',async()=>{
 const f=await fixture();await f.ask();
 const document=await f.admit({id:'answer',type:'user.tool_confirmation',toolUseId:'tool',result:'allow',processedAt:null});
 expect(await f.inputs.consume({claim,inputId:'answer',turnId:'dispatch-answer',expectedDocument:document,boundary:'before_dispatch',consumingTurnId:f.root.turnId,rootInputId:'root',expectedRootDocument:f.root.expectedDocument})).toMatchObject({type:'consumed'});
 const mutate=()=>f.admit({id:'racing-tool',type:'agent.tool_use',name:'read',input:{},evaluatedPermission:'ask',processedAt:now});
 const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:async statements=>{await mutate();return f.sql.batch(statements);},...(f.sql.batchChecked?{batchChecked:async(statements,check)=>{await mutate();return f.sql.batchChecked!(statements,check);}}:{})};
 const projection=new SessionRuntimeProjectionApplicationService({workspaceId:'ws',persistence:new SqlSessionRuntimeProjectionPersistence(sql)});
 const result=await ingestEnvironmentWorkRuntimeEvents({claim,sessionId:'s',body:{root:f.root,events:[{id:'raced-running',type:'session.status_running',processed_at:now}]},projection,publish:async()=>{throw new Error('must not publish');}});
 expect(result.type).not.toBe('recorded');expect(await f.sql.prepare("SELECT id FROM managed_session_events WHERE id='raced-running'").first()).toBeNull();
});

for (const d1 of [false,true]) it(`${d1?'D1':'SQLite'}: finalization rejects historical unsafe running without consumed approval evidence`, async () => {
 const f=await fixture(d1);await f.ask();
 // Model an earlier writer's bad canonical row. The new ingress correctly
 // refuses this; recovery/finalization must independently guard old storage.
 const revision=await f.revision()+1;
 const document=JSON.stringify({id:'historical-running',type:'session.status_running',processedAt:now,
  source_position:{revision,index:0,execution_id:f.root.turnId,environment_work:{workId:claim.workId,generation:claim.generation}}});
 await f.sql.prepare("INSERT INTO managed_session_events VALUES('ws','s',NULL,'historical-running','session.status_running',?,0)").bind(document).run();
 await f.sql.prepare("UPDATE managed_sessions SET revision=? WHERE id='s'").bind(revision).run();
 expect(await f.recover()).toMatchObject({type:'gap',reason:'requires_action_pending'});
 expect((await f.finalize()).type).not.toBe('committed');
 expect(await f.sql.prepare("SELECT id FROM managed_session_events WHERE id LIKE 'work-terminal:%'").all()).toMatchObject({results:[]});
});
for (const d1 of [false,true]) it(`${d1?'D1':'SQLite'}: descendant admission requires ordered root-bound parent tool lineage`,async()=>{
 const f=await fixture(d1);
 const tool={id:'spawn',type:'agent.tool_use',name:'Agent',input:{},processed_at:now};
 const created={id:'created',type:'session.thread_created',session_thread_id:'child',parent_tool_use_id:'spawn',agent_name:'Child',processed_at:now};
 const running={id:'child-running',type:'session.thread_status_running',session_thread_id:'child',agent_name:'Child',processed_at:now};
 for(const events of [[running],[created,running],[tool,{...created,parent_tool_use_id:'foreign'},running],[tool,{...created,parent_thread_id:'unknown'},running]]){
  const before=await f.revision();expect((await f.send(events)).type).not.toBe('recorded');expect(await f.revision()).toBe(before);
 }
 expect(await f.send([tool,created,running])).toMatchObject({type:'recorded'});
 expect(JSON.parse(await f.read('created')).source_position).toMatchObject({execution_id:f.root.turnId,environment_work:{workId:'w',generation:2}});
 // Root/sibling tools must not be usable as if executed inside this child.
 expect((await f.send([{id:'borrow',type:'agent.tool_result',session_thread_id:'child',tool_use_id:'spawn',content:[],processed_at:now}])).type).not.toBe('recorded');
 expect((await f.send([{...created,id:'reparent',parent_tool_use_id:'spawn'}])).type).not.toBe('recorded');
 expect((await f.send([{id:'child-ask',type:'agent.tool_use',session_thread_id:'child',name:'bash',input:{},evaluated_permission:'ask',processed_at:now}])).type).not.toBe('recorded');
 expect(await f.send([{id:'nested-tool',type:'agent.tool_use',session_thread_id:'child',name:'Agent',input:{},processed_at:now},{...created,id:'nested-created',session_thread_id:'grandchild',parent_thread_id:'child',parent_tool_use_id:'nested-tool'}])).toMatchObject({type:'recorded'});
 expect(await f.send([{id:'child-done',type:'session.thread_status_idle',session_thread_id:'child',agent_name:'Child',stop_reason:{type:'end_turn'},processed_at:now}])).toMatchObject({type:'recorded'});
 expect((await f.send([{id:'arbitrary-child',type:'agent.message',session_thread_id:'alien',content:[],processed_at:now}])).type).not.toBe('recorded');
});
