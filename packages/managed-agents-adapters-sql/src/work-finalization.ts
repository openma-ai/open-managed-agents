import type { SqlClient } from "@open-managed-agents/sql-client";
import { outstandingRequiresAction } from "@open-managed-agents/session-runtime-contract/requires-action";
import { decodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";
import {
  SessionRuntimeProjectionApplicationService, sessionBudgetExhausted, inspectCanonicalWorkTurn,
  type WorkFinalizationPersistencePort, type WorkTurnRequest, type WorkTurnState,
  type WorkTerminalReceipt, type WorkTurnRevision, type WorkTerminalStopReason,
  type RuntimeProducedSessionEvent,
} from "@open-managed-agents/managed-agents-application";
import { SqlSessionRuntimeProjectionPersistence } from "./session-runtime-projection-sql-persistence";

type Source=ReturnType<typeof decodeSessionEventDocument>;
type Row={document:string;sequence?:number};
const reject=(reason:string)=>({type:"rejected" as const,reason});
const gap=(reason:string)=>({type:"gap" as const,reason});


/** Reads immutable canonical input/terminal evidence, never Session idle alone.
 * Legacy/unattributed history fails closed. No additional ledger or migration. */
export class SqlWorkFinalization implements WorkFinalizationPersistencePort {
  constructor(private readonly sql:SqlClient,private readonly options:{dialect?:"sqlite"|"postgres"|"mysql"}={}){}
  private get dialect(){return this.options.dialect??"sqlite";}
  private get clock(){return this.dialect==="postgres" ? "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint"
    : this.dialect==="mysql" ? "floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000)"
    : "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";}
  private async revision({claim:c}:WorkTurnRequest):Promise<number|null>{
    const row=await this.sql.prepare(`SELECT revision FROM managed_sessions s WHERE workspace_id=? AND id=? AND environment_id=? AND archived_at IS NULL
      AND EXISTS(SELECT 1 FROM managed_environment_work w WHERE w.workspace_id=s.workspace_id AND w.session_id=s.id AND w.environment_id=? AND w.id=?
        AND w.state IN ('starting','active','stopping') AND w.claim_generation=? AND w.claim_worker_id=? AND w.claim_at IS NOT NULL
        AND w.claim_at+w.heartbeat_ttl_seconds*1000>${this.clock})`)
      .bind(c.workspaceId,c.sessionId,c.environmentId,c.environmentId,c.workId,c.generation,c.holder).first<{revision:number}>();
    return row===null?null:Number(row.revision);
  }
  private async load(input:WorkTurnRequest):Promise<{state:WorkTurnState;source?:Row & {decoded:Source}}>{
    const c=input.claim;
    if(![c.workspaceId,c.sessionId,c.environmentId,c.workId,c.holder,input.turnId].every(v=>typeof v==="string"&&v.length>0)||!Number.isSafeInteger(c.generation)||c.generation<1)return {state:reject("claim")};
    const revision=await this.revision(input);
    if(revision===null)return {state:reject("claim")};
    const [events,initial]=await Promise.all([
      this.sql.prepare("SELECT document FROM managed_session_events WHERE workspace_id=? AND session_id=?").bind(c.workspaceId,c.sessionId).all<Row>(),
      this.sql.prepare("SELECT document,sequence FROM managed_session_initial_events WHERE workspace_id=? AND session_id=?").bind(c.workspaceId,c.sessionId).all<Row>(),
    ]);
    const snapshot = [...(events.results ?? []), ...(initial.results ?? [])]
      .map(row => ({ ...row, decoded: decodeSessionEventDocument(row.document) }));
    const plan = inspectCanonicalWorkTurn({ rows: snapshot, revision, sessionId: c.sessionId,
      turnId: input.turnId, workId: c.workId, generation: c.generation });
    if (plan.type !== "turn") return { state: plan };
    // A queued input is not another active execution. Finishing this consumed
    // turn never stops Work or consumes its successor. A successor that has
    // already started does block old-turn state/physical publication.
    if (plan.successors.some(next => next.consumption === "other-turn")) {
      return { state: reject("newer_input") };
    }
    // Pending successors do not invalidate admission of the earlier root.
    // Bootstrap chooses canonical order; this read never consumes either input.
    const { rows, source, terminal } = plan;
    if(!terminal && source.decoded.consumedByExecutionId===undefined) {
      // Admission is distinct from terminal evidence. Reuse the shared parked
      // call planner; its latest status is never a committed-turn receipt.
      const wire=rows.map(({decoded:{event}})=>{
        const e=event as typeof event & {customToolUseId?:string;toolUseId?:string;sessionThreadId?:string;stopReason?:{type:string;eventIds?:string[]}};
        return {...e,session_thread_id:e.sessionThreadId,custom_tool_use_id:e.customToolUseId,tool_use_id:e.toolUseId,
          stop_reason:e.stopReason && {type:e.stopReason.type,event_ids:e.stopReason.eventIds}};
      });
      const pending=outstandingRequiresAction(wire);
      if(pending && pending.length>0)return {state:gap("requires_action_pending")};
      const current=await new SqlSessionRuntimeProjectionPersistence(this.sql, { dialect: this.dialect }).findCurrent(c);
      if(current && sessionBudgetExhausted(current.session))return {state:gap("budget_paused")};
      const work=await this.sql.prepare("SELECT state FROM managed_environment_work WHERE workspace_id=? AND id=?")
        .bind(c.workspaceId,c.workId).first<{state:string}>();
      if(work?.state==="stopping")return {state:reject("work_stopping")};
    }
    if(await this.revision(input)!==revision)return {state:reject("authority_changed")};
    return {state:{type:"current",revision,consumed:source.decoded.consumedByExecutionId===input.turnId,terminal},source};
  }
  async inspect(input:WorkTurnRequest):Promise<WorkTurnState>{return (await this.load(input)).state;}
  async commit(input:WorkTurnRevision & {stopReason:WorkTerminalStopReason;processedAt:string;failure?:"run"|"finalization"}):Promise<WorkTurnState>{
    const {state,source}=await this.load(input);
    if(state.type!=="current")return state;
    if(state.terminal)return state;
    if(state.revision!==input.revision || !state.consumed || !source)return reject("turn_revision");
    const persistence=new SqlSessionRuntimeProjectionPersistence(this.sql, { dialect: this.dialect });
    const current=await persistence.findCurrent(input.claim);
    if(!current || current.revision!==input.revision)return reject("turn_revision");
    const id=`work-terminal:${encodeURIComponent(input.claim.workId)}:${input.claim.generation}:${encodeURIComponent(input.turnId)}:${input.revision}`;
    const events:RuntimeProducedSessionEvent[]=input.failure ? [
      {id:id+":error",type:"session.error",processedAt:input.processedAt,error:{type:"unknown_error",message:input.failure==="run"?"Work run failed":"Work finalization failed",retryStatus:"exhausted"}},
      {id,type:"session.status_idle",processedAt:input.processedAt,stopReason:{type:"retries_exhausted"}},
    ] : [{id,type:"session.status_idle",processedAt:input.processedAt,stopReason:input.stopReason}];
    // Reuse the existing budget/usage/exhausted policy, while constraining its
    // persistence to the caller's *captured* revision rather than refreshing it.
    const application=new SessionRuntimeProjectionApplicationService({workspaceId:input.claim.workspaceId,persistence:{
      findCurrent:async()=>current,
      project:command=>persistence.project({...command,expectedRevision:input.revision,workFinalization:{holder:input.claim.holder,turnId:input.turnId,
        inputId:source.decoded.event.id,inputDocument:source.document,bootstrapSequence:source.sequence,dialect:this.dialect}}),
    }});
    const result=await application.recordSessionRuntimeEvents({sessionId:input.claim.sessionId,environmentWorkFence:input.claim,events});
    if(result.type!=="recorded")return reject(result.type);
    return this.inspect(input);
  }
}
