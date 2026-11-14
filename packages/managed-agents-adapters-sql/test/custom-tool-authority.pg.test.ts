import {beforeAll,beforeEach,afterAll,expect,it,inject} from 'vitest';
import postgres from 'postgres';
import {PostgresSqlClient} from '@open-managed-agents/sql-client/adapters/postgres';
import {SqlCustomToolInvocations,customInvocationSchema} from '../src/custom-tool-invocations';
import {CustomToolInvocations} from '@open-managed-agents/managed-agents-application';
import type {StorageIntegrationConfig} from '../../../test/storage-integration';
const url=process.env.CUSTOM_INVOCATIONS_PG_URL ?? (inject('storageIntegration') as StorageIntegrationConfig|undefined)?.postgres.customInvocations;
const parsed=url?new URL(url):null;
if(!parsed||parsed.hostname!=='127.0.0.1'||!/^\/openma_custom_test_[a-z0-9_]+$/.test(parsed.pathname)||parsed.search||parsed.hash)throw Error('Dedicated loopback openma_custom_test_* database required');
const schema='custom_'+crypto.randomUUID().replaceAll('-','');
const conn=postgres(url!,{max:6,connection:{search_path:schema}});
const sql=new PostgresSqlClient(conn as unknown as ConstructorParameters<typeof PostgresSqlClient>[0]);
const scope={workspaceId:'ws',sessionId:'s',environmentId:'env',workId:'w',generation:1,holder:'owner',turnId:'turn'};
const store=()=>new SqlCustomToolInvocations(sql,{dialect:'postgres'});
const core=()=>new CustomToolInvocations(store());
beforeAll(async()=>{await sql.exec(`CREATE SCHEMA ${schema}`);});
beforeEach(async()=>{await sql.exec(`DROP TABLE IF EXISTS managed_custom_invocations,managed_sessions,managed_environment_work;
CREATE TABLE managed_sessions(workspace_id TEXT,id TEXT,environment_id TEXT,archived_at BIGINT,revision BIGINT);
CREATE TABLE managed_environment_work(workspace_id TEXT,session_id TEXT,environment_id TEXT,id TEXT,state TEXT,claim_generation BIGINT,claim_worker_id TEXT,claim_at BIGINT,heartbeat_ttl_seconds BIGINT);
INSERT INTO managed_sessions VALUES('ws','s','env',NULL,1);
INSERT INTO managed_environment_work VALUES('ws','s','env','w','active',1,'owner',floor(extract(epoch FROM clock_timestamp())*1000)::bigint,90);
${customInvocationSchema}`);});
afterAll(async()=>{try{await sql.exec(`DROP SCHEMA ${schema} CASCADE`);}finally{await conn.end();}});
it('real PG durable receipt CAS preserves distinct identical calls and rejects stale authority',async()=>{
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
for(const table of ['managed_sessions','managed_environment_work','managed_custom_invocations'])it(`real PG rechecks lease after blocking on ${table}`,async()=>{
 const c=core(),a=await c.begin(scope,{name:'approve'},{});
 await sql.exec("UPDATE managed_environment_work SET claim_at=floor(extract(epoch FROM clock_timestamp())*1000)::bigint-89500");
 let release!:()=>void,locked!:()=>void;const ready=new Promise<void>(r=>locked=r),wait=new Promise<void>(r=>release=r);
 const blocker=conn.begin(async tx=>{await tx.unsafe(`SELECT * FROM ${table} FOR UPDATE`);locked();await wait;});await ready;
 const operation=store().replace(scope,a,{...a,revision:2,nativeCallId:'late',state:'pending'});
 try{
  const deadline=Date.now()+5000;let observed=false;
  while(Date.now()<deadline){const rows=await conn.unsafe("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");if(rows[0].n>0){observed=true;break;}await new Promise(r=>setTimeout(r,10));}
  expect(observed).toBe(true);
  while((await conn.unsafe("SELECT claim_at+heartbeat_ttl_seconds*1000 <= floor(extract(epoch FROM clock_timestamp())*1000)::bigint expired FROM managed_environment_work"))[0].expired!==true)await new Promise(r=>setTimeout(r,10));
 }finally{release();await blocker;}
 expect(await operation).toBe(false);
 expect(JSON.parse((await sql.prepare('SELECT document FROM managed_custom_invocations WHERE receipt=?').bind(a.receipt).first<{document:string}>())!.document)).toMatchObject({state:'unbound',revision:1});
});

it('PG concurrent original-ID binding has one winner and preserves full native ID bytes',async()=>{
 const c=core();const a=await c.begin(scope,{name:'approve'},{}),b=await c.begin(scope,{name:'approve'},{});
 const outcomes=await Promise.allSettled([c.bind(scope,a.receipt,'one-original'),c.bind(scope,b.receipt,'one-original')]);
 expect(outcomes.filter(x=>x.status==='fulfilled')).toHaveLength(1);
 expect(outcomes.filter(x=>x.status==='rejected')).toHaveLength(1);
 const long='x'.repeat(1024),extra=await c.begin(scope,{name:'approve'},{});
 await c.bind(scope,extra.receipt,long);expect((await core().read(scope,extra.receipt)).nativeCallId).toBe(long);
 expect(Number((await sql.prepare("SELECT count(*) n FROM managed_custom_invocations WHERE native_call_id='one-original'").first<{n:number}>())!.n)).toBe(1);
});

import {cancellationAuthorityTests} from './custom-cancellation-authority.shared';
cancellationAuthorityTests(sql,core,'postgres');
