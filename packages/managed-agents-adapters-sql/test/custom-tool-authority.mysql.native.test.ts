import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {createMysql2SqlClient} from '@open-managed-agents/sql-client';
import {SqlCustomToolInvocations,customInvocationMysqlSchema} from '../src/custom-tool-invocations';
import {CustomToolInvocations} from '@open-managed-agents/managed-agents-application';
const url=process.env.CUSTOM_INVOCATIONS_MYSQL_URL;
const parsed=url?new URL(url):null;
if(!parsed||parsed.hostname!=='127.0.0.1'||!/^\/openma_custom_test_[a-z0-9_]+$/.test(parsed.pathname)||parsed.search||parsed.hash)throw Error('Dedicated loopback openma_custom_test_* database required');
const sql=await createMysql2SqlClient(url!);
const scope={workspaceId:'ws',sessionId:'s',environmentId:'env',workId:'w',generation:1,holder:'owner',turnId:'turn'};
const store=()=>new SqlCustomToolInvocations(sql,{dialect:'mysql'});
const core=()=>new CustomToolInvocations(store());

beforeEach(async()=>{await sql.exec(`DROP TABLE IF EXISTS managed_custom_invocations,managed_sessions,managed_environment_work;
CREATE TABLE managed_sessions(workspace_id VARCHAR(191),id VARCHAR(191),environment_id VARCHAR(191),archived_at BIGINT,revision BIGINT);
CREATE TABLE managed_environment_work(workspace_id VARCHAR(191),session_id VARCHAR(191),environment_id VARCHAR(191),id VARCHAR(191),state VARCHAR(32),claim_generation BIGINT,claim_worker_id VARCHAR(191),claim_at BIGINT,heartbeat_ttl_seconds BIGINT);
INSERT INTO managed_sessions VALUES('ws','s','env',NULL,1);
INSERT INTO managed_environment_work VALUES('ws','s','env','w','active',1,'owner',floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000),90);
${customInvocationMysqlSchema}`);});
afterAll(async()=>{await sql.close();});
it('real MySQL durable receipt CAS preserves distinct identical calls and rejects stale authority',async()=>{
 const c=core();const [a,b]=await Promise.all([c.begin(scope,{name:'approve'},{same:true}),c.begin(scope,{name:'approve'},{same:true})]);
 expect(a.receipt).not.toBe(b.receipt);
 await c.bind(scope,a.receipt,'original-a');await c.bind(scope,b.receipt,'original-b');
 expect(await core().read(scope,a.receipt)).toMatchObject({nativeCallId:'original-a',state:'pending'});
 await expect(c.bind(scope,b.receipt,'original-a')).rejects.toThrow();
 await expect(c.read({...scope,holder:'stale'},a.receipt)).rejects.toThrow();
 await expect(c.read({...scope,holder:'OWNER'},a.receipt)).rejects.toThrow();
 await expect(c.read({...scope,canonicalRevision:0},a.receipt)).rejects.toThrow();
 await c.resolve(scope,a.receipt,'original-a',{content:[{type:'text',text:'answer'}],isError:false});
 expect(await core().read(scope,a.receipt)).toMatchObject({state:'resolved'});
 await sql.exec("UPDATE managed_environment_work SET claim_generation=2,claim_worker_id='new-owner'");
 await expect(c.cancel(scope,b.receipt)).rejects.toThrow();
 expect(await c.cancel({...scope,generation:2,holder:'new-owner'},b.receipt)).toMatchObject({state:'cancelled'});
});
for(const table of ['managed_sessions','managed_environment_work','managed_custom_invocations'])it(`real MySQL rechecks lease after blocking on ${table}`,async()=>{
 const c=core(),a=await c.begin(scope,{name:'approve'},{});
 await sql.exec("UPDATE managed_environment_work SET claim_at=floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000)-89500");
 let release!:()=>void,locked!:()=>void;const ready=new Promise<void>(r=>locked=r),wait=new Promise<void>(r=>release=r);
 const blocker=sql.rowLockTransactions.run(async tx=>{await tx.prepare(`SELECT * FROM ${table} FOR UPDATE`).all();locked();await wait;});await ready;
 const operation=store().replace(scope,a,{...a,revision:2,nativeCallId:'late',state:'pending'});
 try{
  const deadline=Date.now()+5000;let observed=false;
  while(Date.now()<deadline){const row=await sql.prepare("SELECT count(*) n FROM performance_schema.data_lock_waits").first<{n:number}>();if(row!.n>0){observed=true;break;}await new Promise(r=>setTimeout(r,10));}
  expect(observed).toBe(true);
  while((await sql.prepare("SELECT claim_at+heartbeat_ttl_seconds*1000 <= floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000) expired FROM managed_environment_work").first<{expired:number}>())!.expired!==1)await new Promise(r=>setTimeout(r,10));
 }finally{release();await blocker;}
 expect(await operation).toBe(false);
 expect(JSON.parse((await sql.prepare('SELECT document FROM managed_custom_invocations WHERE receipt=?').bind(a.receipt).first<{document:string}>())!.document)).toMatchObject({state:'unbound',revision:1});
});

it('MySQL concurrent original-ID binding has one winner and preserves full native ID bytes',async()=>{
 const c=core();const a=await c.begin(scope,{name:'approve'},{}),b=await c.begin(scope,{name:'approve'},{});
 const outcomes=await Promise.allSettled([c.bind(scope,a.receipt,'one-original'),c.bind(scope,b.receipt,'one-original')]);
 expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
 expect(outcomes.filter(x=>x.status==='rejected')).toHaveLength(1);
 const long='x'.repeat(1024),extra=await c.begin(scope,{name:'approve'},{});
 await c.bind(scope,extra.receipt,long);expect((await core().read(scope,extra.receipt)).nativeCallId).toBe(long);
 expect(Number((await sql.prepare("SELECT count(*) n FROM managed_custom_invocations WHERE native_call_id='one-original'").first<{n:number}>())!.n)).toBe(1);
});

import {cancellationAuthorityTests} from './custom-cancellation-authority.shared';
cancellationAuthorityTests(sql,core,'mysql');

import {ensureMysqlCustomInvocationSchema} from '../src/custom-tool-invocations';
import {ensureMysqlWorkInputsSchema} from '../src/work-inputs';
it('real MySQL native migration verifies binary identities and digest uniqueness',async()=>{
 await expect(ensureMysqlCustomInvocationSchema(sql)).resolves.toBeUndefined();
 await sql.exec("ALTER TABLE managed_custom_invocations MODIFY native_call_id VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci");
 await expect(ensureMysqlCustomInvocationSchema(sql)).rejects.toThrow(/identity column native_call_id/);
});
it('real MySQL Work input migration accepts server spelling but rejects a changed bootstrap literal',async()=>{
 await sql.exec("DROP TABLE IF EXISTS managed_session_events,managed_session_initial_events");
 await sql.exec("CREATE TABLE managed_session_events(workspace_id VARCHAR(191),session_id VARCHAR(191),document LONGTEXT)");
 await sql.exec("CREATE TABLE managed_session_initial_events(workspace_id LONGTEXT,session_id VARCHAR(191),sequence BIGINT,document LONGTEXT)");
 await Promise.all([ensureMysqlWorkInputsSchema(sql),ensureMysqlWorkInputsSchema(sql)]);
 await ensureMysqlWorkInputsSchema(sql);
 const row=await sql.prepare("SHOW CREATE TABLE managed_session_initial_events").first<Record<string,string>>();
 const expression=row!['Create Table']!.match(/`work_input_invalid`[^\n]* GENERATED ALWAYS AS \((.*)\) STORED/)![1]!;
 await sql.exec("ALTER TABLE managed_session_initial_events MODIFY work_input_invalid TINYINT GENERATED ALWAYS AS ("+expression.replace('bootstrap_','BOOTSTRAP_')+") STORED");
 await expect(ensureMysqlWorkInputsSchema(sql)).rejects.toThrow(/unexpected generated definition/);
});
