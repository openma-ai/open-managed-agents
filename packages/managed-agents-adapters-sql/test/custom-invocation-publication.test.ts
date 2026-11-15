import { URL } from "node:url";
import { afterAll, expect, it } from 'vitest';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {createBetterSqlite3SqlClient,type SqlClient} from '../../sql-client/src/index';
import {CfD1SqlClient} from '../../sql-client/src/adapters/cf-d1';
import {SqlWorkInputs} from '../../managed-agents-adapters-sql/src/work-inputs';
import {SqlSessionRuntimeProjectionPersistence} from '../../managed-agents-adapters-sql/src/session-runtime-projection-sql-persistence';
import {SessionRuntimeProjectionApplicationService} from '../../managed-agents-application/src/session-execution/application';
import {ingestEnvironmentWorkRuntimeEvents} from '../../managed-agents-adapters-runtime/src/environment-work-runtime-ingress';
const closes:Array<()=>Promise<unknown>>=[];afterAll(async()=>{for(const close of closes)await close();});
const claim={workspaceId:'ws',environmentId:'env',sessionId:'s',workId:'w',generation:2,holder:'holder'};
const now='2026-11-10T00:00:00.000Z';
async function fixture(d1=false){
 let sql!:SqlClient;
 if(d1){const require=createRequire(import.meta.url);const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve('wrangler/package.json'))('miniflare');const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:'2026-11-01',d1Databases:['DB']}));closes.push(()=>mf.dispose());sql=new CfD1SqlClient(await mf.getD1Database('DB'));}
 const database=d1 ? null : join(await mkdtemp(join(tmpdir(),'pr545-mcp-publication-')),'state.sqlite');
 if(!d1) sql=await createBetterSqlite3SqlClient(database!);
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
 return {sql,database,read,admit,inputs,root,revision};
}

import {customInvocationSchema,SqlCustomToolInvocations} from '../src/custom-tool-invocations';
import {CustomToolInvocations} from '../../managed-agents-application/src/custom-tool-invocations';
for(const d1 of [false,true]) it(`${d1?'D1':'SQLite'}: receipt binding and canonical publication commit together`,async()=>{
 const f=await fixture(d1);await f.sql.exec(customInvocationSchema);
 const core=new CustomToolInvocations(new SqlCustomToolInvocations(f.sql));
 const scope={...claim,turnId:f.root.turnId};
 const one=await core.begin(scope,{name:'approve'},{value:1});
 const two=await core.begin(scope,{name:'approve'},{value:1});
 const event=(id:string)=>({id,type:'agent.custom_tool_use',name:'approve',input:{value:1},processed_at:now});
 const send=(events:any[],bindings:any[])=>ingestEnvironmentWorkRuntimeEvents({claim,sessionId:'s',body:{events,root:f.root,customInvocations:bindings},projection:new SessionRuntimeProjectionApplicationService({workspaceId:'ws',persistence:new SqlSessionRuntimeProjectionPersistence(f.sql)}),publish:async()=>{}});
 const before=await f.revision();
 expect(await send([event('native-1'),event('native-2'),{id:'park',type:'session.status_idle',stop_reason:{type:'requires_action',event_ids:['native-1','native-2']},processed_at:now}],[{receipt:one.receipt,nativeCallId:'native-1'},{receipt:two.receipt,nativeCallId:'native-2'}])).toMatchObject({type:'recorded'});
 expect(await core.read(scope,one.receipt)).toMatchObject({state:'pending',nativeCallId:'native-1'});
 expect(await core.read(scope,two.receipt)).toMatchObject({state:'pending',nativeCallId:'native-2'});
 expect(await f.revision()).toBe(before+1);
 expect(JSON.parse(await f.read('park')).stopReason).toEqual({type:'requires_action',eventIds:['native-1','native-2']});
 expect(JSON.parse(await f.read('native-1'))).toMatchObject({type:'agent.custom_tool_use',input:{value:1}});
 // A later event INSERT failure must roll back the earlier receipt UPDATE.
 const three=await core.begin(scope,{name:'approve'},{value:1});
 await f.sql.prepare("CREATE TRIGGER fail_custom_publication BEFORE INSERT ON managed_session_events WHEN NEW.id='native-fail' BEGIN SELECT RAISE(ABORT,'controlled publication failure'); END").run();
 await expect(send([event('native-fail')],[{receipt:three.receipt,nativeCallId:'native-fail'}])).rejects.toThrow('controlled publication failure');
 expect(await core.read(scope,three.receipt)).toMatchObject({state:'unbound',nativeCallId:null});
 expect(await f.sql.prepare("SELECT id FROM managed_session_events WHERE id='native-fail'").first()).toBeNull();
 expect(await f.revision()).toBe(before+1);
 // The receipt is not authority for an altered definition or a second native ID.
 expect((await send([{...event('forged'),name:'forged'}],[{receipt:three.receipt,nativeCallId:'forged'}])).type).not.toBe('recorded');
 expect((await send([event('rebound')],[{receipt:one.receipt,nativeCallId:'rebound'}])).type).not.toBe('recorded');
 expect(await core.read(scope,three.receipt)).toMatchObject({state:'unbound'});
 // A fresh input has its own turn ID; canonical consumption resolves the
 // original receipt, not a record looked up in the answer's new turn.
 const answer=await f.admit({id:'answer',type:'user.custom_tool_result',customToolUseId:'native-1',content:[{type:'text',text:'approved'}],isError:false,processedAt:null});
 const consume={claim,inputId:'answer',turnId:'dispatch-answer',expectedDocument:answer,boundary:'before_dispatch' as const};
 await f.sql.prepare("CREATE TRIGGER fail_answer_commit BEFORE UPDATE OF revision ON managed_sessions WHEN NEW.revision > OLD.revision BEGIN SELECT RAISE(ABORT,'controlled answer commit failure'); END").run();
 await expect(f.inputs.consume(consume)).rejects.toThrow('controlled answer commit failure');
 expect(await core.read(scope,one.receipt)).toMatchObject({state:'pending',result:null});
 expect(JSON.parse(await f.read('answer')).source_position.consumed_by_execution_id).toBeUndefined();
 await f.sql.prepare('DROP TRIGGER fail_answer_commit').run();
 if(f.database) {
  // Fresh OS process uses the same production consumer against persisted bytes.
  // No process-local pending map or original MCP connection is available.
  const {stdout}=await promisify(execFile)(process.execPath,['--import',fileURLToPath(new URL('../../../node_modules/.pnpm/node_modules/tsx/dist/loader.mjs',import.meta.url)),fileURLToPath(new URL('./fixtures/consume-custom-answer.ts',import.meta.url)),f.database,JSON.stringify(consume)]);
  expect(JSON.parse(stdout)).toMatchObject({type:'consumed'});
 } else expect(await new SqlWorkInputs(f.sql,{sourcePositionsValidated:true}).consume(consume)).toMatchObject({type:'consumed'});
 expect(await new CustomToolInvocations(new SqlCustomToolInvocations(f.sql)).read(scope,one.receipt)).toMatchObject({state:'resolved',nativeCallId:'native-1',result:{content:[{type:'text',text:'approved'}],isError:false}});
 expect(await core.read(scope,two.receipt)).toMatchObject({state:'pending'});
 const duplicate=await f.admit({id:'duplicate',type:'user.custom_tool_result',customToolUseId:'native-1',content:[{type:'text',text:'overwrite'}],processedAt:null});
 expect((await f.inputs.consume({claim,inputId:'duplicate',turnId:'dispatch-duplicate',expectedDocument:duplicate,boundary:'before_dispatch'})).type).not.toBe('consumed');
 expect(JSON.parse(await f.read('duplicate')).source_position.consumed_by_execution_id).toBeUndefined();
});

for(const d1 of [false,true]) it(`${d1?'D1':'SQLite'}: receipt CAS race rolls back the whole Work batch`,async()=>{
 const f=await fixture(d1);await f.sql.exec(customInvocationSchema);
 const core=new CustomToolInvocations(new SqlCustomToolInvocations(f.sql));
 const scope={...claim,turnId:f.root.turnId};
 const invocation=await core.begin(scope,{name:'approve'},{value:1});
 let mutated=false;
 const mutate=async()=>{if(!mutated){mutated=true;await core.cancel(scope,invocation.receipt);}};
 const sql:SqlClient={prepare:q=>f.sql.prepare(q),exec:q=>f.sql.exec(q),batch:async statements=>{await mutate();return f.sql.batch(statements);},...(f.sql.batchChecked?{batchChecked:async(statements,check)=>{await mutate();return f.sql.batchChecked!(statements,check);}}:{})};
 const before=await f.revision();
 const published:unknown[]=[];
 const result=await ingestEnvironmentWorkRuntimeEvents({claim,sessionId:'s',body:{root:f.root,events:[{id:'raced',type:'agent.custom_tool_use',name:'approve',input:{value:1},processed_at:now}],customInvocations:[{receipt:invocation.receipt,nativeCallId:'raced'}]},projection:new SessionRuntimeProjectionApplicationService({workspaceId:'ws',persistence:new SqlSessionRuntimeProjectionPersistence(sql)}),publish:async e=>{published.push(e);}});
 expect(result.type).not.toBe('recorded');expect(published).toEqual([]);
 expect(await f.revision()).toBe(before);
 expect(await core.read(scope,invocation.receipt)).toMatchObject({state:'cancelled',nativeCallId:null});
 expect(await f.sql.prepare("SELECT id FROM managed_session_events WHERE id='raced'").first()).toBeNull();
});

for(const d1 of [false,true]) it(`${d1?'D1':'SQLite'}: exact replay acknowledges the original binding without accepting changed authority or bytes`,async()=>{
 const f=await fixture(d1);await f.sql.exec(customInvocationSchema);
 const core=new CustomToolInvocations(new SqlCustomToolInvocations(f.sql));
 const invocation=await core.begin({...claim,turnId:f.root.turnId},{name:'approve'},{value:1});
 const body={root:f.root,events:[{id:'native-replay',type:'agent.custom_tool_use',name:'approve',input:{value:1},processed_at:now}],customInvocations:[{receipt:invocation.receipt,nativeCallId:'native-replay'}]};
 const send=(value:any)=>ingestEnvironmentWorkRuntimeEvents({claim,sessionId:'s',body:value,projection:new SessionRuntimeProjectionApplicationService({workspaceId:'ws',persistence:new SqlSessionRuntimeProjectionPersistence(f.sql)}),publish:async()=>{}});
 expect(await send(body)).toMatchObject({type:'recorded'});const revision=await f.revision();
 expect(await send(body)).toMatchObject({type:'recorded'});expect(await f.revision()).toBe(revision);
 expect((await send({...body,events:[{...body.events[0],input:{value:2}}]})).type).not.toBe('recorded');
 expect((await send({...body,customInvocations:[{...body.customInvocations[0],receipt:crypto.randomUUID()}]})).type).not.toBe('recorded');
 expect((await send({...body,customInvocations:[]})).type).not.toBe('recorded');
 await f.sql.prepare("UPDATE managed_environment_work SET claim_worker_id='replacement' WHERE id='w'").run();
 expect((await send(body)).type).not.toBe('recorded');
 await f.sql.prepare("UPDATE managed_environment_work SET claim_worker_id='holder',claim_generation=3 WHERE id='w'").run();
 expect((await send(body)).type).not.toBe('recorded');
 expect(await f.revision()).toBe(revision);
 expect((await f.sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE id='native-replay'").first<{n:number}>())!.n).toBe(1);
});
