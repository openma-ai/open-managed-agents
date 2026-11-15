import { inspectWorkApprovalResolution } from "../session-execution/work-approval-resolution";
import type { decodeSessionEventDocument } from "@open-managed-agents/session-runtime-contract/history";
import type { WorkFinalizationRejection, WorkTerminalReceipt } from "./ports";
export interface CanonicalWorkTurnRow {
  document: string;
  sequence?: number;
  decoded: ReturnType<typeof decodeSessionEventDocument>;
}
/** A successor is separate from whether the requested turn has completed.
 * This is scheduling evidence, never authorization to stop the resident Work. */
export interface CanonicalWorkSuccessor {
  inputId: string;
  dispatchId: string;
  consumption: "pending" | "other-turn";
  consumingTurnId?: string;
}
export type CanonicalWorkTurnInspection = WorkFinalizationRejection | {
  type: "turn"; source: CanonicalWorkTurnRow; rows: CanonicalWorkTurnRow[];
  pendingRequestIds: string[]; consumed: boolean; terminal: WorkTerminalReceipt | null; successors: CanonicalWorkSuccessor[];
};

/** Pure interpretation of a canonical snapshot. This grants no authority:
 * the SQL adapter still validates the live claim and commits under revision CAS.
 * Input identity, consuming turn and source Work generation remain distinct. */
type Source = CanonicalWorkTurnRow["decoded"];
const reject = (reason: string) => ({ type: "rejected" as const, reason });
const gap = (reason: string) => ({ type: "gap" as const, reason });
const runnable=(s:Source)=>["user.message","user.tool_confirmation","user.custom_tool_result","user.tool_result","user.define_outcome"].includes(s.event.type)
  || (s.event.type==="session.updated" && (s.event as {resume?:boolean}).resume===true);
const compare=(a:Source,b:Source)=>a.position!.revision-b.position!.revision || a.position!.index-b.position!.index;
/** Admission identity is not consumption ownership (main d45d7dc1 uses the
 * active execution's identity for mid-turn steering). Only the persisted
 * consumer marker can fold a later input into the root; processed_at, latest
 * status, tool result correlation and an in-process admitted set cannot.
 * Producer must stamp this under its existing fenced input CAS. */
function consumedByTurn(source:Source,turnId:string):boolean {
  const event=source.event as typeof source.event & {
    cancelled_at_ms?:unknown;_queued?:unknown;deferredUntilToolResults?:unknown;deferred_until_tool_results?:unknown;
  };
  return source.consumedByExecutionId===turnId && typeof event.processedAt==="string" && Number.isFinite(Date.parse(event.processedAt)) &&
    event.cancelled_at_ms==null && event._queued!==true && event.deferredUntilToolResults===undefined && event.deferred_until_tool_results===undefined;
}

export function inspectCanonicalWorkTurn(input: {
  rows: readonly CanonicalWorkTurnRow[]; revision: number; sessionId: string;
  turnId: string; workId: string; generation: number;
}): CanonicalWorkTurnInspection {
  const { revision, sessionId, turnId, workId, generation } = input;
  const rows = [...input.rows];
  if(rows.some(r=>!r.decoded.position || r.decoded.position.revision>revision))return gap("canonical_position_required");
  rows.sort((a,b)=>compare(a.decoded,b.decoded));
  if(rows.some((r,i)=>i>0&&compare(rows[i-1]!.decoded,r.decoded)===0))return gap("canonical_position_collision");
  const candidates=rows.filter(r=>runnable(r.decoded)&&(r.decoded.executionId??r.decoded.event.id)===turnId);
  if(candidates.length!==1)return reject("canonical_turn");
  const source=candidates[0]!;
  if(source.sequence!==undefined && (source.decoded.position!.revision!==1 || source.decoded.position!.index!==source.sequence || source.decoded.event.id!==`bootstrap_${sessionId}:${source.sequence}`))return gap("bootstrap_identity");
  if(source.decoded.consumedByExecutionId!==undefined && source.decoded.consumedByExecutionId!==turnId)return reject("canonical_consumption");
  const rootConsumed = consumedByTurn(source.decoded, turnId);
  const successors: CanonicalWorkSuccessor[] = rows
    .filter(row => runnable(row.decoded) && compare(row.decoded, source.decoded) > 0 &&
      !(rootConsumed && consumedByTurn(row.decoded, turnId)))
    .map(({ decoded }) => ({
      inputId: decoded.event.id,
      dispatchId: decoded.executionId ?? decoded.event.id,
      consumption: decoded.consumedByExecutionId === undefined ? "pending" : "other-turn",
      ...(decoded.consumedByExecutionId === undefined ? {} : { consumingTurnId: decoded.consumedByExecutionId }),
    }));
  const idleFacts = rows.filter(row =>
    row.decoded.event.type === "session.status_idle" && row.decoded.executionId === turnId);
  // Approval idle is a resumable pause of this same native turn. Other idle
  // reasons remain completion fences (including the separately resumed budget).
  const completions = idleFacts.filter(row => row.decoded.event.type === "session.status_idle" &&
    row.decoded.event.stopReason.type !== "requires_action");
  if (completions.length > 1) return gap("ambiguous_terminal");
  for (const { decoded: fact } of idleFacts) {
    if (!fact.environmentWork || fact.environmentWork.workId !== workId ||
        fact.environmentWork.generation > generation || compare(fact, source.decoded) <= 0 ||
        source.decoded.consumedByExecutionId !== turnId) return gap("terminal_attribution");
  }
  let boundary = completions[0];
  if (!boundary) {
    const lastPause = idleFacts.at(-1);
    if (lastPause) {
      const pauseSource = lastPause.decoded.environmentWork!;
      const resumed = rows.some(({ decoded: fact }) =>
        fact.event.type === "session.status_running" && fact.executionId === turnId &&
        fact.environmentWork?.workId === pauseSource.workId &&
        fact.environmentWork.generation === pauseSource.generation &&
        compare(fact, lastPause.decoded) > 0);
      if (!resumed) boundary = lastPause;
    }
  }
  // Running is runtime output, never proof of user approval. Also guard
  // historical unsafe rows that predate the ingress resolution check.
  const approvalFacts = rows.filter(({ decoded: fact }) => fact.executionId === turnId &&
    (fact.event.type === "agent.custom_tool_use" ||
      (fact.event.type === "agent.tool_use" && fact.event.evaluatedPermission === "ask") ||
      (fact.event.type === "session.status_idle" && fact.event.stopReason.type === "requires_action")));
  const stillParked = boundary?.decoded.event.type === "session.status_idle" &&
    boundary.decoded.event.stopReason.type === "requires_action";
  let pendingRequestIds: string[] = [];
  if (approvalFacts.length > 0 && !stillParked) {
    const raw: unknown = JSON.parse(source.document);
    const position = raw && typeof raw === "object" ? (raw as {source_position?: {consumption_claim?: unknown}}).source_position : undefined;
    const consumptionClaim = position?.consumption_claim;
    if (!consumptionClaim || typeof consumptionClaim !== "object") return gap("approval_consumption_evidence_required");
    const claim = consumptionClaim as {workId?:unknown;generation?:unknown;holder?:unknown};
    if (claim.workId !== workId || !Number.isSafeInteger(claim.generation) || Number(claim.generation) < 1 ||
        Number(claim.generation) > generation || typeof claim.holder !== "string" || !claim.holder) {
      return gap("approval_consumption_evidence_required");
    }
    const resolution = inspectWorkApprovalResolution({
      root: {inputId: source.decoded.event.id, turnId, expectedDocument: source.document},
      claim: {workId, generation: Number(claim.generation), holder: claim.holder},
      documents: rows.map(row => row.document),
    });
    if (resolution.type === "invalid") return gap("approval_consumption_evidence_required");
    pendingRequestIds = resolution.pendingRequestIds;
    // Before the first pause, pending custom calls are exactly the state
    // finalization must commit as requires_action. They do not authorize a
    // resume or a completed end_turn; preserve the guard for either boundary.
    if (resolution.pendingRequestIds.length > 0 && idleFacts.length > 0) return gap("requires_action_pending");
  }
  let terminal: WorkTerminalReceipt | null = null;
  if (boundary) {
    const fact = boundary.decoded;
    if (fact.event.type !== "session.status_idle") return gap("terminal_attribution");
    terminal = { eventId: fact.event.id, turnId, workId: fact.environmentWork!.workId,
      generation: fact.environmentWork!.generation, revision: fact.position!.revision,
      stopReason: fact.event.stopReason };
    if (rows.some(({ decoded: later }) =>
      (later.executionId === turnId || later.consumedByExecutionId === turnId) &&
      compare(later, fact) > 0)) return gap("terminal_not_last_turn_fact");
  }
  return { type: "turn", source, rows, pendingRequestIds, consumed: source.decoded.consumedByExecutionId === turnId, terminal, successors };
}
