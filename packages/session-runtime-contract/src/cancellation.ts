/**
 * Shared turn-cancellation semantics (Claude Managed Agents parity).
 *
 * Hosts differ only in how a cancel reaches a turn (CF Durable Object
 * AbortController vs Node execution lease/worker); what the session reports
 * afterwards is decided here so every host emits the same lifecycle:
 *
 * - `interrupt_requested` (a user.interrupt): the turn ends and the session
 *   returns to `session.status_idle` with stop_reason `end_turn`, whether the
 *   turn was already running, still starting, or not yet accepted.
 * - `lease_lost`: another owner holds the execution and re-runs the turn; this
 *   attempt must emit nothing that could race that owner.
 * - `session_*` (session deleted/archived/stopped): the session is going away;
 *   emit nothing.
 */
export type SessionTurnCancelReason =
  | "interrupt_requested"
  | "lease_lost"
  | `session_${string}`
  | (string & {});

export interface InterruptedTurnStopReason {
  type: "end_turn";
}

/** stop_reason for the idle that ends an interrupted turn. The official
 *  StopReason union has no `interrupted` variant; the accompanying
 *  user.interrupt event carries the actual cause. */
export function interruptedTurnStopReason(): InterruptedTurnStopReason {
  return { type: "end_turn" };
}

/** Whether a cancel must stay silent (no trailing idle) for this attempt. */
export function isSilentTurnCancel(reason: string | undefined): boolean {
  return reason === "lease_lost" || (reason?.startsWith("session_") ?? false);
}

/**
 * The idle stop_reason a cancelled (or never-started) turn reports, or `null`
 * when the cancel must emit nothing. Unknown reasons (a generic cancel) end
 * the turn like an interrupt so the session never stays running/rescheduling.
 */
export function idleStopReasonForCancelledTurn(
  reason: SessionTurnCancelReason | undefined,
): InterruptedTurnStopReason | null {
  return isSilentTurnCancel(reason) ? null : interruptedTurnStopReason();
}
