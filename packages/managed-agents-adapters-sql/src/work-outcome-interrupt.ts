import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Session, RuntimeProducedSessionEvent, WorkOutcomeInterruptPort } from "@open-managed-agents/managed-agents-application";
import { decodeSessionEventDocument, encodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";

type Fact=ReturnType<typeof decodeSessionEventDocument>;
const before=(a:Fact,b:Fact)=>!!a.position&&!!b.position&&(a.position.revision<b.position.revision || a.position.revision===b.position.revision&&a.position.index<b.position.index);
/** Narrow server-owned interrupt settlement. This is NOT a stopping runtime
 * ingress: it accepts only a stored input id and derives every output from
 * canonical start/root/claim evidence. No arbitrary event publication port. */
export class SqlWorkOutcomeInterrupt implements WorkOutcomeInterruptPort {
  constructor(private readonly sql:SqlClient,private readonly dialect:"sqlite"|"postgres"|"mysql"="sqlite"){}
  private get clock(){return this.dialect==="postgres"?"floor(extract(epoch FROM clock_timestamp())*1000)::bigint":this.dialect==="mysql"?"floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000)":"(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";}
  async settle(input:{workspaceId:string;sessionId:string;interruptId:string}):Promise<void>{
    for(let attempt=0;attempt<3;attempt++)if(await this.trySettle(input))return;
    throw new Error("Work outcome interrupt settlement changed concurrently");
  }
  private async trySettle(input:{workspaceId:string;sessionId:string;interruptId:string}):Promise<boolean>{
    const {workspaceId,sessionId,interruptId}=input;
    const interruptRow=await this.sql.prepare("SELECT document FROM managed_session_events WHERE workspace_id=? AND session_id=? AND id=?").bind(workspaceId,sessionId,interruptId).first<{document:string}>();
    if(!interruptRow)return true;
    const interrupt=decodeSessionEventDocument(interruptRow.document);
    if(interrupt.event.type!=="user.interrupt" || !interrupt.position || !interrupt.event.environmentWorkId)return true;
    const workId=interrupt.event.environmentWorkId;
    const sessionRow=await this.sql.prepare("SELECT document,revision,environment_id FROM managed_sessions WHERE workspace_id=? AND id=? AND archived_at IS NULL").bind(workspaceId,sessionId).first<{document:string;revision:number;environment_id:string}>();
    if(!sessionRow)return true;
    const work=await this.sql.prepare(`SELECT revision,claim_generation,claim_worker_id,document FROM managed_environment_work WHERE workspace_id=? AND id=? AND session_id=? AND environment_id=? AND state IN ('starting','active','stopping') AND claim_worker_id IS NOT NULL AND claim_at+heartbeat_ttl_seconds*1000>${this.clock}`)
      .bind(workspaceId,workId,sessionId,sessionRow.environment_id).first<{revision:number;claim_generation:number;claim_worker_id:string;document:string}>();
    if(!work)return true;
    const eventRows=await this.sql.prepare("SELECT document FROM managed_session_events WHERE workspace_id=? AND session_id=?").bind(workspaceId,sessionId).all<{document:string}>();
    const initialRows=await this.sql.prepare("SELECT document,sequence FROM managed_session_initial_events WHERE workspace_id=? AND session_id=?").bind(workspaceId,sessionId).all<{document:string;sequence?:number}>();
    const rows:Array<{document:string;sequence?:number}>=[...(eventRows.results??[]),...(initialRows.results??[])];
    const facts=rows.map(r=>decodeSessionEventDocument(r.document));
    if(facts.some(f=>!f.position))throw new Error("Outcome interruption requires canonical positions");
    const session=JSON.parse(sessionRow.document) as Session;
    const next=structuredClone(session);
    const events:RuntimeProducedSessionEvent[]=[];
    const evidence=new Map<string,{document:string;bootstrapSequence?:number}>([[interruptId,{document:interruptRow.document}]]);
    const processedAt=interrupt.event.processedAt ?? new Date().toISOString();
    for(const start of facts){
      const event=start.event;
      if(event.type!=="span.outcome_evaluation_start" || !before(start,interrupt) || !start.executionId || start.environmentWork?.workId!==workId || start.environmentWork.generation!==Number(work.claim_generation))continue;
      const roots=rows.filter(r=>{const f=decodeSessionEventDocument(r.document);return (f.executionId??f.event.id)===start.executionId && f.consumedByExecutionId===start.executionId && before(f,start);});
      if(roots.length!==1)continue;
      const root=JSON.parse(roots[0]!.document);
      const lane=root.sessionThreadId??"sthr_primary";
      if(interrupt.event.sessionThreadId!=null && interrupt.event.sessionThreadId!==lane)continue;
      const claim=root.source_position?.consumption_claim;
      if(!["user.message","user.define_outcome","user.tool_result","user.custom_tool_result","session.updated"].includes(root.type) ||
        typeof root.processedAt!=="string" || !Number.isFinite(Date.parse(root.processedAt)) || root.cancelled_at_ms!=null || root._queued===true ||
        root.deferredUntilToolResults!==undefined || root.deferred_until_tool_results!==undefined)continue;
      if(claim?.workId!==workId || claim.generation!==Number(work.claim_generation) || claim.holder!==work.claim_worker_id)continue;
      if(facts.some(f=>f.event.type==="span.outcome_evaluation_end" && f.event.outcomeEvaluationStartId===event.id))continue;
      // Never close a later iteration, another root, or a completed root based
      // on an earlier accepted interrupt (including idempotent replay).
      if(facts.some(f=>before(start,f) && f.executionId===start.executionId && (f.event.type==="session.status_idle" || f.event.type==="session.status_terminated")))continue;
      const aggregate=next.outcomeEvaluations.find(e=>e.outcomeId===event.outcomeId);
      if(!aggregate || aggregate.result!=="evaluating" || aggregate.iteration!==event.iteration || aggregate.completedAt!==null)continue;
      if(facts.some(f=>f.event.type==="span.outcome_evaluation_start" && f.event.outcomeId===event.outcomeId && before(start,f)))continue;
      const end:RuntimeProducedSessionEvent={id:`work-interrupt:${interruptId}:${event.id}`,type:"span.outcome_evaluation_end",outcomeId:event.outcomeId,iteration:event.iteration,
        outcomeEvaluationStartId:event.id,result:"interrupted",explanation:"Evaluation interrupted by user",processedAt,usage:{inputTokens:0,outputTokens:0,cacheCreationInputTokens:0,cacheReadInputTokens:0}};
      events.push(end);
      evidence.set(event.id,{document:rows.find(r=>decodeSessionEventDocument(r.document).event.id===event.id)!.document});
      evidence.set(root.id,{document:roots[0]!.document,bootstrapSequence:roots[0]!.sequence});

      aggregate.result="interrupted";aggregate.explanation=end.explanation;aggregate.completedAt=processedAt;
    }
    if(!events.length)return true;
    if(processedAt>next.updatedAt)next.updatedAt=processedAt;
    const revision=Number(sessionRow.revision);
    let guard=`EXISTS(SELECT 1 FROM managed_sessions WHERE workspace_id=? AND id=? AND revision=? AND environment_id=? AND archived_at IS NULL)
      AND EXISTS(SELECT 1 FROM managed_environment_work WHERE workspace_id=? AND id=? AND session_id=? AND environment_id=? AND revision=? AND claim_generation=? AND claim_worker_id=? AND state IN ('starting','active','stopping') AND claim_at+heartbeat_ttl_seconds*1000>${this.clock})`;
    const bindings=[workspaceId,sessionId,revision,sessionRow.environment_id,workspaceId,workId,sessionId,sessionRow.environment_id,Number(work.revision),Number(work.claim_generation),work.claim_worker_id];
    const rawCas=this.dialect==="mysql"?"BINARY document=BINARY ?":"document=?";
    for(const [id,proof] of evidence){
      guard+=` AND EXISTS(SELECT 1 FROM ${proof.bootstrapSequence===undefined?"managed_session_events":"managed_session_initial_events"} WHERE workspace_id=? AND session_id=? AND ${proof.bootstrapSequence===undefined?"id":"sequence"}=? AND ${rawCas})`;
      bindings.push(workspaceId,sessionId,proof.bootstrapSequence??id,proof.document);
    }
    const statements=[
      this.sql.prepare(`UPDATE managed_sessions SET revision=revision WHERE workspace_id=? AND id=? AND ${guard}`).bind(workspaceId,sessionId,...bindings),
      this.sql.prepare("UPDATE managed_environment_work SET revision=revision WHERE workspace_id=? AND id=? AND revision=?").bind(workspaceId,workId,Number(work.revision)),
      ...events.map((event,index)=>{const start=facts.find(f=>f.event.id===(event as Extract<RuntimeProducedSessionEvent,{type:"span.outcome_evaluation_end"}>).outcomeEvaluationStartId)!;
        return this.sql.prepare(`INSERT INTO managed_session_events(workspace_id,session_id,thread_id,id,type,document,processed_at) SELECT ?,?,NULL,?,?,?,? WHERE ${guard} ON CONFLICT(workspace_id,session_id,id) DO NOTHING`)
          .bind(workspaceId,sessionId,event.id,event.type,encodeSessionEventDocument(event,{revision:revision+1,index},start.executionId,undefined,start.environmentWork),Date.parse(processedAt),...bindings);}),
      this.sql.prepare(`UPDATE managed_sessions SET document=?,revision=revision+1,updated_at=? WHERE workspace_id=? AND id=? AND ${guard}`).bind(JSON.stringify(next),Date.parse(next.updatedAt),workspaceId,sessionId,...bindings),
    ];
    // Revoke publication and close the evaluation atomically. Otherwise the
    // worker can observe stopping, clear its claim, and beat server settlement.
    // The existing lifecycle stop subsequently sees the same stopping record.
    const workDocument=JSON.parse(work.document);
    const stopped={...workDocument,state:"stopping",stopRequestedAt:workDocument.stopRequestedAt??processedAt};
    const stoppedBindings=[...bindings];stoppedBindings[2]=revision+1;
    statements.push(this.sql.prepare(`UPDATE managed_environment_work SET document=?,state='stopping',revision=revision+1 WHERE workspace_id=? AND id=? AND ${guard}`)
      .bind(JSON.stringify(stopped),workspaceId,workId,...stoppedBindings));
    const conflict=new Error("interrupt CAS");
    try{
      if(this.sql.batchChecked)await this.sql.batchChecked(statements,results=>{if(results.some((r,i)=>i!==1&&r.meta.changes!==1))throw conflict;});
      else await this.sql.batch(statements.flatMap((s,i)=>i===1?[s]:[s,this.sql.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE abs(-9223372036854775808) END")]));
      return true;
    }catch(error){if(error===conflict || !this.sql.batchChecked&&error instanceof Error&&error.message.includes("integer overflow"))return false;throw error;}
  }
}
