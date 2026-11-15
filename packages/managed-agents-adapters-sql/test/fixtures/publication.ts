import {URL} from 'node:url';
import {expect} from 'vitest';
import {readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createBetterSqlite3SqlClient,type SqlClient} from '../../../sql-client/src/index';
import {CfD1SqlClient} from '../../../sql-client/src/adapters/cf-d1';
import {SqlWorkInputs} from '../../src/work-inputs';
export const claim={workspaceId:'ws',environmentId:'env',sessionId:'s',workId:'w',generation:2,holder:'holder'};
export const now='2026-11-10T00:00:00.000Z';
const closes:Array<()=>Promise<unknown>>=[];
export async function closeFixtures(){for(const close of closes.splice(0))await close();}
export async function fixture(d1=false){
 let sql!:SqlClient;
 if(d1){const require=createRequire(import.meta.url);const {Miniflare,convertV4MiniflareOptions}=createRequire(require.resolve('wrangler/package.json'))('miniflare');const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:'2026-11-01',d1Databases:['DB']}));closes.push(()=>mf.dispose());sql=new CfD1SqlClient(await mf.getD1Database('DB'));}
 const database=d1 ? null : join(await mkdtemp(join(tmpdir(),'pr545-mcp-publication-')),'state.sqlite');
 if(!d1) sql=await createBetterSqlite3SqlClient(database!);
 await sql.exec(`CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,document TEXT,revision INTEGER,created_at INTEGER,updated_at INTEGER,archived_at INTEGER,environment_id TEXT,agent_id TEXT,agent_version INTEGER,deployment_id TEXT,status TEXT,PRIMARY KEY(workspace_id,id));
 CREATE TABLE managed_session_threads(workspace_id TEXT,session_id TEXT,id TEXT,document TEXT,updated_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));
 CREATE TABLE managed_environment_work(workspace_id TEXT,environment_id TEXT,id TEXT,session_id TEXT,state TEXT,claim_generation INTEGER,claim_at INTEGER,heartbeat_ttl_seconds INTEGER,revision INTEGER,document TEXT,claim_worker_id TEXT,created_at INTEGER,PRIMARY KEY(workspace_id,id));
 CREATE TABLE managed_session_events(workspace_id TEXT,session_id TEXT,thread_id TEXT,id TEXT,type TEXT,document TEXT,processed_at INTEGER,PRIMARY KEY(workspace_id,session_id,id));
 CREATE TABLE managed_session_initial_events(workspace_id TEXT,session_id TEXT,sequence INTEGER,document TEXT,PRIMARY KEY(workspace_id,session_id,sequence));`);
 for(const s of (await readFile(new URL('../../../../apps/main-node/migrations-sqlite/0034_work_inputs.sql', import.meta.url),'utf8')).split('--> statement-breakpoint'))await sql.prepare(s).run();
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
