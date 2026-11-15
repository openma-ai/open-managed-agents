import type { SqlClient } from '@open-managed-agents/sql-client';
import type { CustomInvocation, ProjectSessionRuntimeState } from '@open-managed-agents/managed-agents-application';

/** Prepare receipt CAS writes for the EXISTING canonical projection transaction.
 * Reads are only optimistic evidence: exact receipt bytes and Session/Work/root
 * authority are checked again by each write, and all row counts are asserted.
 * Argument comparison validates a definition; it never selects an invocation. */
export async function customInvocationPublicationStatements(input: {
 sql: SqlClient; projection: ProjectSessionRuntimeState; turnId: string;
 dialect?:'sqlite'|'postgres'|'mysql'; fenceSql: string; fenceBindings: Array<string | number>;
}) {
 const {sql,projection:p,turnId,fenceSql,fenceBindings}=input;
 const statements=[];
 const receipts=new Set<string>(), calls=new Set<string>();
 for(const binding of p.customInvocations ?? []) {
  if(receipts.has(binding.receipt)||calls.has(binding.nativeCallId)) return null;
  receipts.add(binding.receipt);calls.add(binding.nativeCallId);
  const event=p.events.find(e=>e.id===binding.nativeCallId);
  if(!event || event.type!=='agent.custom_tool_use' || event.sessionThreadId) return null;
  const row=await sql.prepare(`SELECT document FROM managed_custom_invocations
   WHERE workspace_id=? AND session_id=? AND environment_id=? AND turn_id=? AND receipt=?`)
   .bind(p.workspaceId,p.sessionId,p.environmentWorkFence!.environmentId,turnId,binding.receipt).first<{document:string}>();
  if(!row) return null;
  const before=JSON.parse(row.document) as CustomInvocation;
  if(before.state!=='unbound'||before.nativeCallId!==null||before.name!==event.name||!equalJson(before.arguments,event.input)) return null;
  const after:CustomInvocation={...before,state:'pending',nativeCallId:binding.nativeCallId,revision:before.revision+1};
  if(input.dialect && input.dialect!=='sqlite') statements.push(sql.prepare(input.dialect==='mysql'?'SELECT receipt FROM managed_custom_invocations WHERE workspace_id=? AND session_id=? AND receipt=? FOR UPDATE':'UPDATE managed_custom_invocations SET revision=revision WHERE workspace_id=? AND session_id=? AND receipt=?').bind(p.workspaceId,p.sessionId,binding.receipt));
  statements.push(sql.prepare(`UPDATE managed_custom_invocations SET native_call_id=?,revision=?,document=?
   WHERE workspace_id=? AND session_id=? AND environment_id=? AND turn_id=? AND receipt=? AND revision=? AND ${input.dialect==='mysql'?'BINARY document=BINARY ?':'document=?'}
   AND EXISTS (SELECT 1 FROM managed_sessions WHERE workspace_id=? AND id=? AND revision=?) ${fenceSql}`)
   .bind(after.nativeCallId,after.revision,JSON.stringify(after),p.workspaceId,p.sessionId,p.environmentWorkFence!.environmentId,turnId,binding.receipt,before.revision,row.document,
    p.workspaceId,p.sessionId,p.expectedRevision,...fenceBindings));
 }
 return statements;
}
function equalJson(a:unknown,b:unknown):boolean {
 if(a===b)return true;
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
 const left=a as Record<string,unknown>,right=b as Record<string,unknown>;
 const keys=Object.keys(left);
 return keys.length===Object.keys(right).length && keys.every(k=>Object.hasOwn(right,k)&&equalJson(left[k],right[k]));
}

/** Only an already-admitted canonical answer can resolve a receipt. This
 * statement joins the existing Work input consumption transaction; neither an
 * MCP caller nor a disconnected request can publish an external answer. */
export async function customInvocationAnswerStatement(input: {
 sql:SqlClient; workspaceId:string; sessionId:string; environmentId:string;
 event:Record<string,unknown>; sessionWhere:string; scope:Array<string|number>; dialect?:'sqlite'|'postgres'|'mysql';
}) {
 const {sql,event}=input;
 if(event.type!=='user.custom_tool_result') return {statement:null};
 const call=await sql.prepare("SELECT document FROM managed_session_events WHERE workspace_id=? AND session_id=? AND id=? AND type='agent.custom_tool_use'")
  .bind(input.workspaceId,input.sessionId,event.customToolUseId).first<{document:string}>();
 if(!call) return {statement:null}; // Legacy/native custom tools retain their existing admission path.
 const canonical=JSON.parse(call.document);
 const receipt=canonical.source_position?.custom_invocation_receipt;
 if(receipt===undefined) return {statement:null};
 const turnId=canonical.source_position?.execution_id;
 if(typeof receipt!=='string'||typeof turnId!=='string')return null;
 const row=await sql.prepare(`SELECT document FROM managed_custom_invocations WHERE workspace_id=? AND session_id=? AND environment_id=? AND turn_id=? AND receipt=? AND native_call_id=?`)
  .bind(input.workspaceId,input.sessionId,input.environmentId,turnId,receipt,event.customToolUseId).first<{document:string}>();
 if(!row)return null;
 const before=JSON.parse(row.document) as CustomInvocation;
 if(before.state!=='pending'||before.nativeCallId!==event.customToolUseId || (event.content!==undefined && !Array.isArray(event.content)))return null;
 const after:CustomInvocation={...before,state:'resolved',result:{content:(event.content ?? []) as unknown[],isError:event.isError===true},revision:before.revision+1};
 return {locks:input.dialect && input.dialect!=='sqlite'?[sql.prepare(input.dialect==='mysql'?'SELECT receipt FROM managed_custom_invocations WHERE workspace_id=? AND session_id=? AND receipt=? FOR UPDATE':'UPDATE managed_custom_invocations SET revision=revision WHERE workspace_id=? AND session_id=? AND receipt=?').bind(input.workspaceId,input.sessionId,receipt)]:[],statement:sql.prepare(`UPDATE managed_custom_invocations SET revision=?,document=?
  WHERE workspace_id=? AND session_id=? AND environment_id=? AND turn_id=? AND receipt=? AND ${input.dialect==='mysql'?'BINARY document=BINARY ?':'document=?'}
  AND EXISTS (SELECT 1 FROM managed_session_events WHERE workspace_id=? AND session_id=? AND id=? AND ${input.dialect==='mysql'?'BINARY document=BINARY ?':'document=?'})
  AND EXISTS (SELECT 1 FROM managed_sessions WHERE ${input.sessionWhere})`)
  .bind(after.revision,JSON.stringify(after),input.workspaceId,input.sessionId,input.environmentId,turnId,receipt,row.document,
   input.workspaceId,input.sessionId,event.customToolUseId,call.document,...input.scope)};
}
