import type { WorkInputClaim } from "../session-execution/work-inputs";
import type { RuntimeProducedSessionEvent } from "../session-execution/port";

export type WorkFinalizationClaim = WorkInputClaim;
export type WorkTerminalStopReason = Extract<RuntimeProducedSessionEvent, {type:"session.status_idle"}>["stopReason"];
export interface WorkTerminalReceipt {
  eventId: string;
  turnId: string;
  workId: string;
  /** Source generation of the committed fact, not the current cleanup owner. */
  generation: number;
  revision: number;
  stopReason: WorkTerminalStopReason;
}
export interface WorkTurnRequest { claim: WorkFinalizationClaim; turnId: string }
export interface WorkTurnRevision extends WorkTurnRequest { revision: number }
export type WorkFinalizationRejection = {type:"rejected";reason:string} | {type:"gap";reason:string;revision?:number};
export type WorkTurnState = WorkFinalizationRejection | {
  type:"current";
  revision:number;
  consumed:boolean;
  terminal:WorkTerminalReceipt|null;
};
export interface WorkFinalizationPersistencePort {
  inspect(input:WorkTurnRequest):Promise<WorkTurnState>;
  /** Canonical turn + Work/holder + Session revision checked in same CAS as events. */
  commit(input:WorkTurnRevision & {stopReason:WorkTerminalStopReason;processedAt:string;failure?:"run"|"finalization"}):Promise<WorkTurnState>;
}
export interface WorkFinalizationScope extends WorkTurnRevision {
  /** Check before physical work AND in the host's existing publication CAS.
   * This callback alone is NOT an atomic storage/checkpoint publication fence. */
  isCurrent():Promise<boolean>;
}
/** Trusted host injection, never implemented by a request-supplied receipt.
 * Resolve physical runtime by the whole claim, including issued holder. Reuse
 * Work authority and existing resource/checkpoint publication ports; never mint
 * SessionExecution authority. prepare must synchronize storage and strictly publish any due checkpoint.
 * Common/supervisor must first drain actual tools/subagents and persist native
 * state; these are not inferred from client flags or duplicated by this Port.
 * Lost/conflicting snapshots are failure, not a warning. Retain provider renewal
 * until publish and Work settlement. Both operations must be retry safe.
 */
export interface WorkFinalizationHostPort {
  prepare(scope:WorkFinalizationScope):Promise<{type:"prepared"}|{type:"unavailable"}>;
  /** Original canonical outcome is immutable even when this fails. */
  publish(scope:WorkFinalizationScope & {terminal:WorkTerminalReceipt}):Promise<{type:"published"}|{type:"unavailable"}>;
}
