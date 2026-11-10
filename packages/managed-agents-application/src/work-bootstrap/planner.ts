import { sessionExecutionEvents } from "@open-managed-agents/session-runtime-contract/coordination";
import { outstandingRequiresAction } from "@open-managed-agents/session-runtime-contract/requires-action";
import type { SentSessionEvent } from "@open-managed-agents/domain/sessions";
import { inspectCanonicalWorkTurn, type CanonicalWorkTurnRow } from "../work-finalization/turn-plan";
import type { WorkFinalizationClaim } from "../work-finalization/ports";
import type { WorkBootstrapCandidate, WorkBootstrapRoot } from "./ports";
const rootOf=(row:CanonicalWorkTurnRow):WorkBootstrapRoot=>({inputId:row.decoded.event.id,turnId:row.decoded.executionId??row.decoded.event.id,position:row.decoded.position!});
const order=(a:CanonicalWorkTurnRow,b:CanonicalWorkTurnRow)=>a.decoded.position!.revision-b.decoded.position!.revision||a.decoded.position!.index-b.decoded.position!.index;
const runnable=(row:CanonicalWorkTurnRow)=>["user.message","user.tool_confirmation","user.custom_tool_result","user.tool_result","user.define_outcome"].includes(row.decoded.event.type)||(row.decoded.event.type==="session.updated"&&(row.decoded.event as {resume?:boolean}).resume===true);
/** An accepted interrupt binds its exact old Work at ingress. A replacement
 * consumer may leave that cancelled root behind, but must never manufacture a
 * successful terminal or replay its unknown side effects. Same-Work interrupts
 * remain the live owner's responsibility. Missing legacy proof stays a gap. */
function interruptedPreviousWork(root:CanonicalWorkTurnRow,rows:readonly CanonicalWorkTurnRow[],claim:WorkFinalizationClaim):boolean {
 const raw=JSON.parse(root.document) as {source_position?:{consumption_claim?:{workId?:unknown;generation?:unknown;holder?:unknown}}};
 const consumed=raw.source_position?.consumption_claim;
 if(!consumed||typeof consumed.workId!=="string"||!consumed.workId||consumed.workId===claim.workId||
   !Number.isSafeInteger(consumed.generation)||Number(consumed.generation)<1||typeof consumed.holder!=="string"||!consumed.holder)return false;
 const lane=(event:CanonicalWorkTurnRow["decoded"]["event"]) => (event as {sessionThreadId?:string}).sessionThreadId??"sthr_primary";
 return rows.some(row=>{
  const event=row.decoded.event as typeof row.decoded.event & {environmentWorkId?:string|null;sessionThreadId?:string};
  return event.type==="user.interrupt"&&event.environmentWorkId===consumed.workId&&order(row,root)>0&&
   (event.sessionThreadId==null||lane(event)===lane(root.decoded.event));
 });
}
/** Candidate only, never a claim/admission receipt. Caller must validate through
 * persistence + finalization.inspect, then consumption performs the real CAS. */
export function planWorkBootstrap(input:{claim:WorkFinalizationClaim;revision:number;rows:readonly CanonicalWorkTurnRow[];budgetExhausted:boolean}):WorkBootstrapCandidate {
 const {claim,revision}=input;
 const gap=(reason:string,root?:WorkBootstrapRoot):WorkBootstrapCandidate=>({type:"gap",reason,...(root?{root}:{})});
 if(input.rows.some(r=>!r.decoded.position||r.decoded.position.revision>revision))return gap("canonical_position_required");
 const rows=[...input.rows].sort(order);
 if(rows.some((r,i)=>i>0&&order(rows[i-1]!,r)===0))return gap("canonical_position_collision");
 if(rows.some(r=>r.sequence!==undefined&&(r.decoded.position!.revision!==1||r.decoded.position!.index!==r.sequence||r.decoded.event.id!==`bootstrap_${claim.sessionId}:${r.sequence}`)))return gap("bootstrap_identity");
 const inputs=rows.filter(runnable);
 // A child may only refer to a real earlier root. Never silently lose unknown ownership.
 for(const row of rows){
  const consumer=row.decoded.consumedByExecutionId;
  if(consumer&&!inputs.some(r=>rootOf(r).turnId===consumer&&order(r,row)<=0&&r.decoded.consumedByExecutionId===consumer))return gap("canonical_consuming_root_missing");
 }
 for(const row of rows){
  if(row.decoded.event.type!=="session.status_idle")continue;
  const owner=row.decoded.executionId;
  if(!owner||!inputs.some(r=>rootOf(r).turnId===owner&&r.decoded.consumedByExecutionId===owner&&order(r,row)<0))return gap("canonical_terminal_root_missing");
 }
 const completed:Array<Extract<WorkBootstrapCandidate,{type:"cleanup-only"|"parked"}>>=[];
 for(const row of inputs){
  const root=rootOf(row);
  if(row.decoded.consumedByExecutionId!==root.turnId)continue;
  if(interruptedPreviousWork(row,rows,claim))continue;
  const inspected=inspectCanonicalWorkTurn({rows,revision,sessionId:claim.sessionId,workId:claim.workId,generation:claim.generation,turnId:root.turnId});
  if(inspected.type!=="turn")return {...inspected,root};
  if(!inspected.terminal)return gap("consumed_turn_without_terminal",root);
  completed.push({type:["requires_action","budget_reached"].includes(inspected.terminal.stopReason.type)?"parked":"cleanup-only",root,terminal:inspected.terminal});
 }
 const last=completed.at(-1);
 // Shared main bookkeeping decides whether a continuation may wake a parked
 // turn. A terminal is still proved against its exact consumed root above.
 const wire=rows.map(({decoded:{event}})=>{
  const e=event as typeof event & {sessionThreadId?:string;customToolUseId?:string;toolUseId?:string;stopReason?:{type:string;eventIds?:string[]}};
  return {...e,session_thread_id:e.sessionThreadId,custom_tool_use_id:e.customToolUseId,tool_use_id:e.toolUseId,stop_reason:e.stopReason&&{type:e.stopReason.type,event_ids:e.stopReason.eventIds}};
 });
 if(last?.terminal.stopReason.type==="requires_action"&&(outstandingRequiresAction(wire)?.length??0)>0)return last;
 if(input.budgetExhausted)return last?.terminal.stopReason.type==="budget_reached"?last:gap("budget_paused");
 const eligible=inputs.filter(row=>{
  const e=row.decoded.event as typeof row.decoded.event & {cancelled_at_ms?:unknown;_queued?:boolean;deferredUntilToolResults?:unknown;deferred_until_tool_results?:unknown;heldAfterExhausted?:boolean};
  if(row.decoded.consumedByExecutionId||e.cancelled_at_ms!=null||e._queued===true||e.deferredUntilToolResults!==undefined||e.deferred_until_tool_results!==undefined)return false;
  if(["user.message","user.tool_confirmation"].includes(e.type)&&e.processedAt!==null)return false;
  // Main exhausted policy holds older queued input until fresh admission. Do
  // not manufacture an admission from the old terminal or processed timestamps.
  if(last?.terminal.stopReason.type==="retries_exhausted"&&row.decoded.position!.revision<=last.terminal.revision)return false;
  if(last?.terminal.stopReason.type==="requires_action"&&e.type==="user.message")return false;
  return true;
 });
 const executable=sessionExecutionEvents(eligible.map(r=>r.decoded.event as SentSessionEvent));
 const selected=eligible.find(r=>executable.some(e=>e.id===r.decoded.event.id));
 if(selected){
  const root=rootOf(selected);
  const inspected=inspectCanonicalWorkTurn({rows,revision,sessionId:claim.sessionId,workId:claim.workId,generation:claim.generation,turnId:root.turnId});
  if(inspected.type!=="turn")return {...inspected,root};
  return {type:"run",root};
 }
 return last??{type:"idle",root:null};
}
