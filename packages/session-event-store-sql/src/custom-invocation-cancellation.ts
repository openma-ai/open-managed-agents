import {encodeSessionEventDocument} from '@open-managed-agents/session-runtime-contract/history';
import type {SqlClient} from '@open-managed-agents/sql-client';
import type {AppendSessionEvents} from '@open-managed-agents/session-event-store';

/** Canonical admission owns cancellation, never MCP socket lifetime. These
 * writes join the Session append transaction and use its revision lock. */
export async function customInvocationCancellationStatements(sql:SqlClient,input:AppendSessionEvents,dialect:'sqlite'|'postgres'|'mysql'='sqlite') {
 const clock=dialect==='postgres'?"floor(extract(epoch FROM clock_timestamp())*1000)::bigint":dialect==='mysql'?"floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000)":"(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
 const holderSql=dialect==='mysql'?'BINARY claim_worker_id=BINARY ?':'claim_worker_id=?';
 const documentSql=dialect==='mysql'?'BINARY document=BINARY ?':'document=?';
 const interrupts=input.events.filter(e=>e.type==='user.interrupt'&&typeof e.environmentWorkId==='string');
 if(!interrupts.length)return [];
 const rows=(await sql.prepare('SELECT document FROM managed_session_events WHERE workspace_id=? AND session_id=?').bind(input.workspaceId,input.sessionId).all<{document:string}>()).results??[];
 const facts=rows.map(r=>JSON.parse(r.document));
 // Only MCP receipts explicitly published by Core are eligible. Legacy tools
 // and deployments without this table are untouched.
 const calls=facts.filter(e=>e.type==='agent.custom_tool_use'&&typeof e.source_position?.custom_invocation_receipt==='string');
 const statements=[];
 let resultIndex=input.events.length;
 for(const call of calls){
  const source=call.source_position;
  const work=source.environment_work;
  const interrupt=interrupts.find(e=>e.type==='user.interrupt'&&e.environmentWorkId===work?.workId&&(e.sessionThreadId==null||e.sessionThreadId===(call.sessionThreadId??'sthr_primary')));
  if(!interrupt)continue;
  const owner=await sql.prepare('SELECT claim_generation,claim_worker_id FROM managed_environment_work WHERE workspace_id=? AND id=? AND session_id=?').bind(input.workspaceId,work.workId,input.sessionId).first<{claim_generation:number;claim_worker_id:string|null}>();
  if(!owner||!owner.claim_worker_id||Number(owner.claim_generation)!==work.generation)continue;
  if(facts.concat(input.events).some(e=>(e.type==='user.custom_tool_result'&&e.customToolUseId===call.id)||(e.type==='agent.tool_result'&&e.toolUseId===call.id)))continue;
  const receipt=await sql.prepare('SELECT document FROM managed_custom_invocations WHERE workspace_id=? AND session_id=? AND turn_id=? AND receipt=? AND native_call_id=?')
   .bind(input.workspaceId,input.sessionId,source.execution_id,source.custom_invocation_receipt,call.id).first<{document:string}>();
  if(!receipt)throw Error('Canonical custom invocation receipt disappeared');
  const before=JSON.parse(receipt.document);if(before.state!=='pending')continue;
  const after={...before,state:'cancelled',revision:before.revision+1};
  if(dialect!=='sqlite') {
   statements.push(sql.prepare('UPDATE managed_environment_work SET claim_generation=claim_generation WHERE workspace_id=? AND id=? AND session_id=?').bind(input.workspaceId,work.workId,input.sessionId));
   statements.push(sql.prepare('UPDATE managed_custom_invocations SET revision=revision WHERE workspace_id=? AND session_id=? AND receipt=?').bind(input.workspaceId,input.sessionId,source.custom_invocation_receipt));
  }
  statements.push(sql.prepare(`UPDATE managed_custom_invocations SET document=?,revision=? WHERE workspace_id=? AND session_id=? AND receipt=? AND ${documentSql}
   AND EXISTS(SELECT 1 FROM managed_sessions WHERE workspace_id=? AND id=? AND revision=?)
   AND EXISTS(SELECT 1 FROM managed_environment_work WHERE workspace_id=? AND id=? AND session_id=? AND claim_generation=? AND ${holderSql} AND state IN ('starting','active','stopping') AND claim_at+heartbeat_ttl_seconds*1000>${clock})`)
   .bind(JSON.stringify(after),after.revision,input.workspaceId,input.sessionId,source.custom_invocation_receipt,receipt.document,input.workspaceId,input.sessionId,input.expectedRevision,input.workspaceId,work.workId,input.sessionId,work.generation,owner.claim_worker_id));
  // The server closes the already-published call in the SAME acceptance
  // transaction. A replacement host hydrates this durable result, never the
  // interrupt itself (which may be a no-op against an idle lane).
  const result={id:`custom-interrupt:${interrupt.id}:${call.id}`,type:'agent.tool_result' as const,
   toolUseId:call.id,content:[{type:'text' as const,text:'Tool execution interrupted by user'}],isError:true,
   processedAt:interrupt.processedAt??input.nextSession.updatedAt,
   ...(call.sessionThreadId?{sessionThreadId:call.sessionThreadId}:{})};
  const document=encodeSessionEventDocument(result,{revision:input.expectedRevision+1,index:resultIndex++},source.execution_id,undefined,work);
  statements.push(sql.prepare(`INSERT INTO managed_session_events(workspace_id,session_id,thread_id,id,type,document,processed_at)
   SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM managed_custom_invocations WHERE workspace_id=? AND session_id=? AND receipt=? AND ${documentSql})
   AND EXISTS(SELECT 1 FROM managed_sessions WHERE workspace_id=? AND id=? AND revision=?)
   AND EXISTS(SELECT 1 FROM managed_environment_work WHERE workspace_id=? AND id=? AND session_id=? AND claim_generation=? AND ${holderSql} AND state IN ('starting','active','stopping') )`)
   .bind(input.workspaceId,input.sessionId,call.sessionThreadId??null,result.id,result.type,document,Date.parse(result.processedAt),
    input.workspaceId,input.sessionId,source.custom_invocation_receipt,JSON.stringify(after),
    input.workspaceId,input.sessionId,input.expectedRevision,input.workspaceId,work.workId,input.sessionId,work.generation,owner.claim_worker_id));

 }
 return statements;
}
