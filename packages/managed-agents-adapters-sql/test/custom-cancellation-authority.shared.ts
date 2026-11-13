import {expect,it} from 'vitest';
import type {SqlClient} from '@open-managed-agents/sql-client';
import type {CustomToolInvocations} from '@open-managed-agents/managed-agents-application';
import {customInvocationCancellationStatements} from '../../session-event-store-sql/src/custom-invocation-cancellation';

export function cancellationAuthorityTests(sql:SqlClient,core:()=>CustomToolInvocations,dialect:'postgres'|'mysql'){
 const scope={workspaceId:'ws',sessionId:'s',environmentId:'env',workId:'w',generation:1,holder:'owner',turnId:'turn'};
 async function fixture(){
  await sql.exec("DROP TABLE IF EXISTS managed_session_events");
  await sql.exec("CREATE TABLE managed_session_events(workspace_id VARCHAR(191),session_id VARCHAR(191),thread_id VARCHAR(191),id VARCHAR(191),type VARCHAR(191),document TEXT,processed_at BIGINT)");
  const receipt=await core().begin(scope,{name:'approve'},{});
  await core().bind(scope,receipt.receipt,'original-call');
  const call={id:'original-call',type:'agent.custom_tool_use',name:'approve',input:{},source_position:{revision:1,index:0,execution_id:'turn',custom_invocation_receipt:receipt.receipt,environment_work:{workId:'w',generation:1}}};
  await sql.prepare("INSERT INTO managed_session_events(workspace_id,session_id,id,type,document) VALUES('ws','s','original-call','agent.custom_tool_use',?)").bind(JSON.stringify(call)).run();
  const statements=await customInvocationCancellationStatements(sql,{workspaceId:'ws',sessionId:'s',expectedRevision:1,events:[{id:'interrupt',type:'user.interrupt',environmentWorkId:'w',processedAt:new Date().toISOString()}],nextSession:{updatedAt:new Date().toISOString()}} as any,dialect);
  return {receipt,statements};
 }
 it('canonical cancellation commits one correlated result and rejects byte-different holder',async()=>{
  const {receipt,statements}=await fixture();
  await sql.prepare("UPDATE managed_environment_work SET claim_worker_id='OWNER'").run();
  await sql.batch(statements);
  let row=await sql.prepare("SELECT document FROM managed_custom_invocations WHERE receipt=?").bind(receipt.receipt).first<{document:string}>();
  expect(JSON.parse(row!.document).state).toBe('pending');
  expect(Number((await sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE type='agent.tool_result'").first<{n:number}>())!.n)).toBe(0);
  await sql.prepare("UPDATE managed_environment_work SET claim_worker_id='owner'").run();
  await sql.batch(statements);
  row=await sql.prepare("SELECT document FROM managed_custom_invocations WHERE receipt=?").bind(receipt.receipt).first<{document:string}>();
  expect(JSON.parse(row!.document).state).toBe('cancelled');
  const events=(await sql.prepare("SELECT document FROM managed_session_events WHERE type='agent.tool_result'").all<{document:string}>()).results ?? [];
  expect(events).toHaveLength(1);expect(JSON.parse(events[0]!.document)).toMatchObject({toolUseId:'original-call',isError:true});
 });
 it('canonical cancellation rejects a lease expired after preparing the append',async()=>{
  const {receipt,statements}=await fixture();
  await sql.prepare("UPDATE managed_environment_work SET claim_at=0").run();
  await sql.batch(statements);
  expect(JSON.parse((await sql.prepare("SELECT document FROM managed_custom_invocations WHERE receipt=?").bind(receipt.receipt).first<{document:string}>())!.document).state).toBe('pending');
  expect(Number((await sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE type='agent.tool_result'").first<{n:number}>())!.n)).toBe(0);
 });
 it('canonical cancellation rechecks database time after waiting for the receipt lock',async()=>{
  const {receipt,statements}=await fixture();
  const clock=dialect==='postgres'?"floor(extract(epoch FROM clock_timestamp())*1000)::bigint":"floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000)";
  await sql.exec("UPDATE managed_environment_work SET claim_at="+clock+"-89500");
  let release!:()=>void,locked!:()=>void;
  const ready=new Promise<void>(r=>locked=r),gate=new Promise<void>(r=>release=r);
  const blocker=sql.rowLockTransactions!.run(async tx=>{
   await tx.prepare("SELECT receipt FROM managed_custom_invocations FOR UPDATE").all();locked();await gate;
  });await ready;
  const operation=sql.batch(statements);
  try{
   const waitSql=dialect==='postgres'?"SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'":"SELECT count(*) AS n FROM performance_schema.data_lock_waits";
   let waiting=false;const deadline=Date.now()+5000;
   while(Date.now()<deadline){if(Number((await sql.prepare(waitSql).first<{n:number}>())!.n)>0){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}
   expect(waiting).toBe(true);
   while(!Number((await sql.prepare("SELECT CASE WHEN claim_at+heartbeat_ttl_seconds*1000<="+clock+" THEN 1 ELSE 0 END AS expired FROM managed_environment_work").first<{expired:number}>())!.expired))await new Promise(r=>setTimeout(r,10));
  }finally{release();await blocker;}
  await operation;
  expect(JSON.parse((await sql.prepare("SELECT document FROM managed_custom_invocations WHERE receipt=?").bind(receipt.receipt).first<{document:string}>())!.document).state).toBe('pending');
  expect(Number((await sql.prepare("SELECT count(*) AS n FROM managed_session_events WHERE type='agent.tool_result'").first<{n:number}>())!.n)).toBe(0);
 });

}
