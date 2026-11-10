import type { SqlClient } from "@open-managed-agents/sql-client";
import { decodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";
import { sessionBudgetExhausted, type WorkFinalizationClaim, type WorkBootstrapPersistencePort, type WorkBootstrapSnapshot } from "@open-managed-agents/managed-agents-application";
import { SqlSessionRuntimeProjectionPersistence } from "./session-runtime-projection-sql-persistence";
/** Read-only canonical selection. No admission/consumption/publication ledger.
 * Revision is checked around the snapshot and again after finalization.inspect. */
export class SqlWorkBootstrap implements WorkBootstrapPersistencePort {
 constructor(private readonly sql:SqlClient,private readonly options:{dialect?:"sqlite"|"postgres"|"mysql"}={}){}
 private get clock(){return this.options.dialect==="postgres"?"floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint":this.options.dialect==="mysql"?"floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000)":"(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";}
 private async authority(c:WorkFinalizationClaim){
  if(![c.workspaceId,c.environmentId,c.sessionId,c.workId,c.holder].every(v=>typeof v==="string"&&v.length>0)||!Number.isSafeInteger(c.generation)||c.generation<1)return null;
  const row=await this.sql.prepare(`SELECT s.revision,w.state FROM managed_sessions s JOIN managed_environment_work w
   ON w.workspace_id=s.workspace_id AND w.session_id=s.id AND w.environment_id=s.environment_id
   WHERE s.workspace_id=? AND s.id=? AND s.environment_id=? AND s.archived_at IS NULL AND w.id=?
    AND w.state IN ('starting','active','stopping') AND w.claim_generation=? AND w.claim_worker_id=?
    AND w.claim_at IS NOT NULL AND w.claim_at+w.heartbeat_ttl_seconds*1000>${this.clock}`)
   .bind(c.workspaceId,c.sessionId,c.environmentId,c.workId,c.generation,c.holder).first<{revision:number;state:string}>();
  return row&&Number.isSafeInteger(Number(row.revision))?{revision:Number(row.revision),state:row.state}:null;
 }
 async isCurrent(claim:WorkFinalizationClaim,revision:number,workState?:string):Promise<boolean>{
  const current=await this.authority(claim);
  return current!==null&&current.revision===revision&&(workState===undefined||current.state===workState);
 }
 async read(claim:WorkFinalizationClaim):Promise<WorkBootstrapSnapshot|{type:"rejected"|"gap";reason:string}>{
  const current=await this.authority(claim);
  if(!current)return {type:"rejected",reason:"claim"};
  // Explicit cap: truncated history is a gap, never authority for a newer root.
  const [events,initial,session]=await Promise.all([
   this.sql.prepare("SELECT document FROM managed_session_events WHERE workspace_id=? AND session_id=? LIMIT 10001").bind(claim.workspaceId,claim.sessionId).all<{document:string}>(),
   this.sql.prepare("SELECT document,sequence FROM managed_session_initial_events WHERE workspace_id=? AND session_id=? LIMIT 10001").bind(claim.workspaceId,claim.sessionId).all<{document:string;sequence:number}>(),
   new SqlSessionRuntimeProjectionPersistence(this.sql, this.options).findCurrent(claim),
  ]);
  if((events.results?.length??0)+(initial.results?.length??0)>10000)return {type:"gap",reason:"bootstrap_history_limit"};
  if(!session||session.revision!==current.revision)return {type:"rejected",reason:"authority_changed"};
  let rows:WorkBootstrapSnapshot["rows"];
  try{rows=[...(events.results??[]),...(initial.results??[])].map(row=>({...row,decoded:decodeSessionEventDocument(row.document)}));}
  catch{return {type:"gap",reason:"canonical_document_invalid"};}
  if(!await this.isCurrent(claim,current.revision,current.state))return {type:"rejected",reason:"authority_changed"};
  return {type:"snapshot",workState:current.state,revision:current.revision,rows,budgetExhausted:sessionBudgetExhausted(session.session)};
 }
}
