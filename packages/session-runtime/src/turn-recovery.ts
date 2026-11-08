/**
 * Read-side counterpart to runAgentTurn: rebuild the state of a turn a process
 * death interrupted, hand it to the caller's resume function, and cap how many
 * times one turn may be recovered.
 */

import type { SessionEvent } from "@open-managed-agents/shared";
import type { TurnRuntimeAgent } from "./turn-lifetime";

export interface PartialStream {
  message_id: string;
  partial_text: string;
  status: "streaming" | "interrupted";
}

export interface RecoveryContext {
  /** Same name passed to the original runAgentTurn. */
  readonly turnName: string;
  /** Events strictly after the last `user.message` — what the agent had emitted. */
  readonly history: SessionEvent[];
  /** Streams that were in flight when the DO died. */
  readonly partialStreams: PartialStream[];
  /** Cumulative recovery attempts on THIS turn — survives across DO restarts via DO storage. */
  readonly recoveryCount: number;
}

export interface RecoveryDecision {
  /** Re-enter the turn (caller resumes processing). Default false. */
  continue: boolean;
  /**
   * If true, persist any partial agent.message extracted from
   * partialStreams as a canonical event so the user / next turn sees what
   * was already streamed. Default false.
   */
  persistPartial?: boolean;
}

export interface RecoverAgentTurnOptions {
  /** Hard upper bound on recoveries per turn. Default 5. */
  maxRecoveries?: number;
  /** Caller-provided event sink for emitting agent.error / status updates. */
  emitEvent?: (event: SessionEvent) => void;
  /** Synchronously persist partial agent.message when decision.persistPartial=true. */
  persistAgentMessage?: (text: string, message_id: string) => void;
  /** Force the session into idle state — emitted when we hit the recovery cap. */
  forceIdle?: () => void;
}

/**
 * Read-side counterpart to runAgentTurn. Called from cf-agents
 * onFiberRecovered when the library detects an orphan fiber row left
 * behind by DO eviction.
 *
 * We pass the caller a typed RecoveryContext built from SQL events and
 * streams (NOT from cf-agents stash — OMA's tables already carry richer
 * state). The caller decides:
 *   - whether to persist any partial agent.message that was streamed
 *     before the eviction (so users see "what the agent was saying" even
 *     though it didn't finish),
 *   - whether to re-enter the turn (resume processing the unfinished
 *     user.message).
 *
 * If recoveryCount exceeds maxRecoveries we stop trying — emit a
 * session.error + force idle so the trial / caller can see a terminal
 * state instead of waiting forever.
 *
 * @returns the caller's RecoveryDecision (after applying persist/continue)
 */
export async function recoverAgentTurn(
  agent: TurnRuntimeAgent,
  ctx: { id: string; name: string; snapshot: unknown },
  loadRecoveryContext: () => Promise<{
    history: SessionEvent[];
    partialStreams: PartialStream[];
  }>,
  resumeFn: (rctx: RecoveryContext) => Promise<RecoveryDecision>,
  opts: RecoverAgentTurnOptions = {},
): Promise<RecoveryDecision> {
  const maxRecoveries = opts.maxRecoveries ?? 5;
  const recoveryKey = `turn_recovery:${ctx.name}`;

  // recoveryCount is persisted to DO storage so survives across restarts.
  const prevCount = (await agent.storage.get<number>(recoveryKey)) ?? 0;
  const nextCount = prevCount + 1;
  await agent.storage.put(recoveryKey, nextCount);

  console.warn(`[recover] turn=${ctx.name} fiber=${ctx.id} count=${nextCount}/${maxRecoveries}`);

  if (nextCount > maxRecoveries) {
    console.error(`[recover] turn=${ctx.name} exceeded ${maxRecoveries} recoveries — aborting`);
    try {
      opts.emitEvent?.({
        type: "session.error",
        error: `turn aborted: exceeded ${maxRecoveries} eviction recoveries on ${ctx.name}. Either DO is being evicted faster than the model call can complete, or the model call itself is hanging.`,
      } as SessionEvent);
    } catch {}
    try {
      opts.forceIdle?.();
    } catch {}
    // Reset for next user.message
    await agent.storage.delete(recoveryKey);
    return { continue: false };
  }

  const { history, partialStreams } = await loadRecoveryContext();
  const decision = await resumeFn({
    turnName: ctx.name,
    history,
    partialStreams,
    recoveryCount: nextCount,
  });

  if (decision.persistPartial && opts.persistAgentMessage) {
    for (const s of partialStreams) {
      if (s.partial_text) {
        try {
          opts.persistAgentMessage(s.partial_text, s.message_id);
        } catch (err) {
          console.warn(`[recover] persistAgentMessage failed for ${s.message_id}: ${err}`);
        }
      }
    }
  }

  if (!decision.continue) {
    // Reset count — the turn is being abandoned, next user.message starts fresh
    await agent.storage.delete(recoveryKey);
  }

  return decision;
}

/**
 * Helper: clear the recovery counter for a turn that just completed
 * successfully via runAgentTurn. Call from the success path so a
 * subsequent eviction on the next turn doesn't inherit stale count.
 */
export async function clearTurnRecoveryCount(
  agent: TurnRuntimeAgent,
  turnName: string,
): Promise<void> {
  await agent.storage.delete(`turn_recovery:${turnName}`);
}
