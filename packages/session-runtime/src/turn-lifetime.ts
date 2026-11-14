/**
 * Turn lifetime for the OMA agent harness.
 *
 * Replaces the tangled mix of withRetry + per-attempt keepAliveWhile +
 * stale-chunk + heartbeat + ctx.waitUntil-backup that grew up inside the
 * host harness and session-do.ts. The contract is:
 *
 *   1. **runAgentTurn**  — mark the turn in flight on the unified
 *      `sessions` table (status='running', turn_id=...) so cold starts
 *      can detect orphans, and synchronously persist workspace state
 *      before returning success or surfacing a typed `TurnError`. NO
 *      internal retry — the caller (eval-runner / app) decides what to
 *      do. Stall detection lives in the host harness next to the provider
 *      stream, not here.
 *
 * Background on the design:
 *   - Lifecycle is now expressed as RuntimeAdapter.beginTurn /
 *     hintTurnInFlight / endTurn — the same shape used by Node
 *     (apps/main-node) and CF (apps/agent SessionDO). The cf-agents
 *     `keepAliveWhile { runFiber { fn } }` chain that lived here in
 *     v0.x has been ripped out: marker rows live on `sessions.turn_id`
 *     not in `cf_agents_runs`; CF's keep-alive (setAlarm 30s) is now
 *     a callback the per-platform shell wires via
 *     adapter.hintTurnInFlight.
 *   - Workspace persistence remains OMA-original: synchronous backup
 *     before runAgentTurn returns.
 *   - We deliberately do NOT carry a per-turn snapshot. OMA's events
 *     and streams tables already carry richer state than any blob; the
 *     recovery path reconstructs from those.
 */

import { nanoid } from "nanoid";
import type { RuntimeAdapter, TurnId } from "./ports";

// ─── Adapter interface ──────────────────────────────────────────────────
//
// `agent.ctx` is `protected` on cf-agents Agent so we can't reach into it
// from this module. The adapter exposes the methods we need from the
// outside; SessionDO constructs one bound to itself and passes it in.

export interface TurnRuntimeAgent {
  /** Unified runtime adapter — beginTurn / endTurn / listOrphanTurns + the
   *  underlying eventLog/streams used by recovery. CF SessionDO and Node
   *  registry both build one of these the same way. */
  adapter: RuntimeAdapter;
  /** Session id this adapter is bound to — passed to beginTurn/endTurn. */
  sessionId: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────

export type TurnError =
  | { kind: "rate_limited"; provider?: string; retry_after_ms?: number; raw?: string }
  | { kind: "do_evicted"; recoveries_used: number }
  | { kind: "stream_stall"; ms_since_last_chunk: number }
  | { kind: "model_timeout"; ms: number }
  | { kind: "model_error"; status?: number; message: string }
  | { kind: "backup_failed"; message: string }
  | { kind: "user_aborted" }
  | { kind: "unexpected"; message: string };

export class TurnAborted extends Error {
  constructor(public readonly cause: TurnError) {
    super(`${cause.kind}: ${JSON.stringify(cause).slice(0, 200)}`);
    this.name = "TurnAborted";
  }
}

// ─── Primitive 1: runAgentTurn ───────────────────────────────────────────

export interface TurnContext {
  /** Stable name for this turn — same value passed to runAgentTurn. */
  readonly turnName: string;
  /** AbortSignal — currently just the caller-provided parentSignal (or never-aborts default). */
  readonly signal: AbortSignal;
}

export interface RunAgentTurnOptions {
  /**
   * Synchronous workspace persistence. Called once at end of turn (success
   * or failure) before runAgentTurn returns. Failure is fatal — surfaced
   * as `TurnError.backup_failed`. Caller passes a function that does
   * whatever durable-state work is needed (e.g. await maybeBackupWorkspace).
   */
  persistWorkspace?: () => Promise<void>;
  /**
   * Optional caller-provided abort signal — exposed verbatim on TurnContext.signal.
   */
  parentSignal?: AbortSignal;
}

/**
 * Run an agent turn with end-to-end lifetime guarantee.
 *
 * Wraps the body in cf-agents `keepAliveWhile { runFiber }` so the DO
 * stays alive for the full turn duration. Stall detection lives inside
 * the host harness next to the provider stream — the
 * runtime no longer composes a stall AbortController. Workspace
 * persistence runs synchronously at end of turn. Errors are typed and
 * thrown as `TurnAborted`. NO internal retry — caller catches
 * TurnAborted and decides next steps.
 *
 * @returns whatever `fn` returns on success
 * @throws TurnAborted on any failure
 */
export async function runAgentTurn<T>(
  agent: TurnRuntimeAgent,
  turnName: string,
  fn: (ctx: TurnContext) => Promise<T>,
  opts: RunAgentTurnOptions = {},
): Promise<T> {
  const turnStartedAt = Date.now();
  const turnId: TurnId = nanoid();

  const ctx: TurnContext = {
    turnName,
    signal: opts.parentSignal ?? new AbortController().signal,
  };

  // Mark the turn in flight on the unified `sessions` table. Cold-start
  // detection (CF: alarm; Node: registry.bootstrap) finds these via
  // adapter.listOrphanTurns. The hint callback is the per-platform
  // shell's keep-alive — CF wires setAlarm(now+30s) here so the DO
  // doesn't get evicted mid-turn; Node leaves it unset (fly/k8s won't
  // evict in-flight HTTP).
  await agent.adapter.beginTurn(agent.sessionId, turnId);
  agent.adapter.hintTurnInFlight?.(agent.sessionId, turnId);

  try {
    let result: T;
    try {
      result = await fn(ctx);
    } catch (err) {
      // Try to persist whatever partial state landed before re-throwing
      // so the next turn / verifier / debugger doesn't lose evidence.
      if (opts.persistWorkspace) {
        try {
          await opts.persistWorkspace();
        } catch (persistErr) {
          console.warn(
            `[turn] persistWorkspace also failed during error path: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
          );
        }
      }
      throw classifyError(err, {
        sinceTurnStart: Date.now() - turnStartedAt,
      });
    }
    // Happy path: persist before returning. Failure here is a real
    // turn failure — caller deserves to know the agent finished but its
    // state didn't land.
    if (opts.persistWorkspace) {
      try {
        await opts.persistWorkspace();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new TurnAborted({ kind: "backup_failed", message: msg });
      }
    }
    return result;
  } finally {
    try {
      await agent.adapter.endTurn(agent.sessionId, turnId, "idle");
    } catch (err) {
      console.warn(`[turn] endTurn failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Symmetric to hintTurnInFlight above. CF shell uses this to drop
    // turnId from its local active set; Node shell no-ops (machine.ts
    // tracks via activeTurnId). Fired before the elapsed-time log so
    // any orphan-detection that runs concurrently sees the up-to-date
    // membership.
    agent.adapter.hintTurnEnded?.(agent.sessionId, turnId);
    const totalElapsed = Date.now() - turnStartedAt;
    console.log(`[turn] END name=${turnName} elapsed=${totalElapsed}ms`);
  }
}

function classifyError(
  err: unknown,
  state: { sinceTurnStart: number },
): TurnAborted {
  if (err instanceof TurnAborted) return err;
  const msg = err instanceof Error ? err.message : String(err);
  // Stall: the harness's in-closure setTimeout fires AbortController.abort()
  // when no chunk arrives for STALE_CHUNK_THRESHOLD_MS. Provider adapters may
  // surface that as either a generic abort error or one with "stalled" in the
  // message — match both.
  if (/stall/i.test(msg)) {
    return new TurnAborted({
      kind: "stream_stall",
      ms_since_last_chunk: state.sinceTurnStart,
    });
  }
  // Pattern-match common provider error shapes. Best-effort classification.
  if (/\b429\b|rate.?limit|too many requests/i.test(msg)) {
    const m = msg.match(/retry-after[:\s]+(\d+)/i);
    return new TurnAborted({
      kind: "rate_limited",
      retry_after_ms: m ? parseInt(m[1], 10) * 1000 : undefined,
      raw: msg.slice(0, 300),
    });
  }
  if (/timeout|timed out|aborted/i.test(msg)) {
    return new TurnAborted({ kind: "model_timeout", ms: 0 });
  }
  if (/^abort/i.test(msg)) {
    return new TurnAborted({ kind: "user_aborted" });
  }
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  if (typeof status === "number") {
    return new TurnAborted({ kind: "model_error", status, message: msg.slice(0, 300) });
  }
  return new TurnAborted({ kind: "unexpected", message: msg.slice(0, 300) });
}
