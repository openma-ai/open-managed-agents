/**
 * user.interrupt against one lane (Claude Managed Agents semantics). The order
 * is decided here; each host supplies the platform actions behind the Port.
 *
 * Against an already-idle lane an interrupt is a no-op that is only recorded,
 * including idle requires_action: event_ids, pending calls and stop_reason
 * stay untouched. Otherwise the running turn is aborted, queued inputs are
 * flushed, still-open tool calls are closed, and the lane ends idle end_turn.
 */

export type LaneStatus = "running" | "idle";

/** The turn currently running on the lane. */
export interface InterruptibleTurn {
  /** Aborts the turn and waits a bounded grace for its tools to unwind. */
  abort(): Promise<void>;
}

export interface TurnInterruptPort {
  activeTurn(): InterruptibleTurn | null;
  /** The lane's last status event in the durable log, decided from history
   * rather than only the in-memory turn: after eviction or a concurrent
   * interrupt the turn can be gone while the log still says running. */
  lastStatus(): LaneStatus | null;
  /** The durable interrupt authority: a replacement host observes it on its
   * next renew or claim and cannot resurrect the cancelled generation. */
  requestDurableInterrupt(): Promise<void>;
  /** The interrupt emits the aborted turn's idle; the turn must not. */
  ownInterruptedIdle(): void;
  /** Flushes the lane's queued inputs; returns how many were cancelled. */
  cancelQueuedInputs(): number;
  /** Settles calls parked on a runner while no turn runs; returns how many
   * were settled, or null when the runner did not confirm. */
  settlePendingActions(): Promise<number | null>;
  /** Stamps and appends the user.interrupt event itself. */
  recordInterrupt(): void;
  /** Closes every still-open tool call so the turn cannot end in
   * requires_action and a late answer cannot resume it. */
  closeOpenToolUses(): number;
  /** status_idle with the interrupted turn's stop_reason. */
  emitIdle(): void;
}

export type TurnInterruptResult =
  /** The lane was idle: the interrupt was only recorded. */
  | "recorded"
  | "interrupted"
  /** A parked runner action could not be settled; nothing was recorded. */
  | "runner_unconfirmed";

export async function interruptTurn(port: TurnInterruptPort): Promise<TurnInterruptResult> {
  const active = port.activeTurn();
  if (active === null && port.lastStatus() === "idle") {
    port.recordInterrupt();
    return "recorded";
  }
  await port.requestDurableInterrupt();
  if (active !== null) {
    port.ownInterruptedIdle();
    await active.abort();
  }
  const cancelled = port.cancelQueuedInputs();
  let settled = 0;
  if (active === null) {
    const count = await port.settlePendingActions();
    if (count === null) return "runner_unconfirmed";
    settled = count;
  }
  port.recordInterrupt();
  const closed = port.closeOpenToolUses();
  const running = port.lastStatus() === "running";
  // A no-op interrupt right after a natural end must not add a second idle.
  if (closed > 0 || settled > 0 || cancelled > 0 || active !== null || running) {
    // A zombie turn whose finally still runs must not emit its own idle.
    if (running || active !== null) port.ownInterruptedIdle();
    port.emitIdle();
  }
  return "interrupted";
}
