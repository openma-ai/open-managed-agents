/**
 * Closes what a dead incarnation left behind: unpaired tool calls, turn markers
 * nothing is running under, and a status_running with no marker at all.
 */

import type { SessionEvent } from "@open-managed-agents/shared";
import type { OrphanTurn, TurnId } from "./ports";

export interface StaleToolUse {
  id: string;
  type: string;
  thread?: string | null;
}

export interface StaleTurnFinalizerPort {
  /** Text of the error result that closes a call whose outcome is unknown. */
  readonly unknownToolResultText: string;
  /** When this host incarnation started, in ms. */
  readonly instanceStartedAt: number;
  now(): number;
  listToolUses(): StaleToolUse[];
  listToolResultIds(): string[];
  /** Calls parked on the client: unpaired by design. */
  parkedCallIds(): string[];
  append(event: SessionEvent): Promise<void>;
  broadcast(event: SessionEvent): void;
  listOrphanTurns(): Promise<OrphanTurn[]>;
  endTurn(turnId: TurnId): Promise<void>;
  isTurnActive(turnId: TurnId): boolean;
  /** A turn, execution or queue drain is running in this incarnation. */
  hasLiveWork(): boolean;
  /** Latest session status event; `ts` in seconds. */
  latestSessionStatus(): { type: string; ts: number } | null;
  /** Ends a running row that has no turn id; false when nothing changed. */
  clearMarkerlessTurn(now: number): Promise<boolean>;
  scheduleGraceRetry(atMs: number): Promise<void>;
  log(event: string, fields: Record<string, unknown>): void;
}

export async function finalizeStaleTurns(port: StaleTurnFinalizerPort): Promise<void> {
  // 1. Unpaired tool_use detection. Three flavors per the wire spec
  //    in default-loop.ts:emitToolCallEvent:
  //      • agent.tool_use         → result keyed by tool_use_id
  //      • agent.custom_tool_use  → result keyed by tool_use_id
  //      • agent.mcp_tool_use     → result keyed by mcp_tool_use_id
  //    The pairing key for use→result is always the use's own `id`.
  //    Wrapped in try blocks so a missing events table (very early
  //    cold-start) doesn't short-circuit the sessions row cleanup
  //    below — that's the contract callers depend on.
  //    Not while this incarnation has live work: a call that is still
  //    running is unpaired too, and closing it here put an "outcome is
  //    unknown" result before its real one (an alarm-driven recovery pass
  //    mid-turn, seen on oma-v2e2b). A dead incarnation's calls are closed
  //    by the next pass once nothing runs.
  const usedIds = port.hasLiveWork() ? new Map<string, StaleToolUse>() : new Map(port.listToolUses().map((use) => [use.id, use] as const));
  if (usedIds.size > 0) {
    for (const id of port.listToolResultIds()) usedIds.delete(id);
  }
  // Calls parked on the client (custom_tool_use awaiting
  // user.custom_tool_result, always_ask awaiting user.tool_confirmation)
  // are unpaired BY DESIGN and survive DO restarts via persisted state.
  // Flushing them injected a synthetic "interrupted" result next to the
  // real one the client posts later → duplicate tool_result → provider
  // 400 "each tool_use must have a single result" + reschedule loop.
  const parked = port.parkedCallIds();
  for (const id of parked) usedIds.delete(id);
  let flushed = 0;
  for (const [id, meta] of usedIds) {
    const isMcp = meta.type === "agent.mcp_tool_use";
    const event = isMcp
      ? {
          type: "agent.mcp_tool_result" as const,
          mcp_tool_use_id: id,
          content: port.unknownToolResultText,
          is_error: true,
        }
      : {
          type: "agent.tool_result" as const,
          tool_use_id: id,
          content: port.unknownToolResultText,
          is_error: true,
        };
    const tagged = (meta.thread
      ? { ...event, session_thread_id: meta.thread }
      : event) as unknown as SessionEvent;
    try {
      await port.append(tagged);
      port.broadcast(tagged);
      flushed++;
    } catch (err) {
      console.warn(`[finalize-stale] failed to flush tool_use ${id}:`, err);
    }
  }

  // 2. Force-end stale sessions rows. Skip turns currently held in
  //    _activeTurnIds (live work in this incarnation). Order matters:
  //    endTurn FIRST (the contract), events only on success. The
  //    earlier shape (rescheduled → endTurn → idle) emitted a
  //    rescheduled event even when endTurn threw, leaving Console
  //    showing "rescheduled" with no resolution and the row still
  //    'running'. Atomic-from-Console's-perspective: events appear
  //    iff the row actually flipped.
  const orphans = await port.listOrphanTurns();
  let ended = 0;
  if (orphans.length > 0 || usedIds.size > 0) {
    port.log("finalize.scan", {
      orphan_turns: orphans.length,
      unpaired_tool_uses: usedIds.size,
      pending_tool_calls: parked.length,
    });
  }
  // Race window: cold-start flush is fire-and-forget from fetch();
  // the same fetch() may concurrently route a POST /event into
  // drainEventQueue → adapter.beginTurn (writes D1 row) →
  // hintTurnInFlight callback (populates _activeTurnIds). If we read
  // listOrphanTurns BETWEEN the D1 write landing and the in-memory
  // set add, the brand-new turn looks like an orphan and we'd
  // incorrectly emit rescheduled+idle for it (caught 2026-05-11
  // bench scenario 08, sess-hn5kmowudx42awm0).
  //
  // The grace period only applies to turns that began in THIS
  // incarnation (`turn_started_at >= _instanceStartedAt`). A turn
  // whose marker predates this instance is from a dead incarnation by
  // definition, even when its timestamp is only a few seconds old —
  // exactly the mid-turn isolate-reset case. Pre-fix, the age-only
  // check skipped such a turn; a fire-and-forget fetch() pass then
  // never ran again and the session stayed status_running forever.
  const FRESH_TURN_GRACE_MS = 30_000;
  const now = port.now();
  let heldForFreshGrace = 0;
  for (const o of orphans) {
    if (port.isTurnActive(o.turn_id)) {
      port.log("finalize.candidate", {
        turn_id: o.turn_id,
        decision: "skip",
        reason: "active_turn",
      });
      continue;
    }
    const startedThisIncarnation = o.turn_started_at >= port.instanceStartedAt;
    if (startedThisIncarnation && now - o.turn_started_at < FRESH_TURN_GRACE_MS) {
      heldForFreshGrace++;
      port.log("finalize.candidate", {
        turn_id: o.turn_id,
        decision: "skip",
        reason: "fresh_grace",
        age_ms: now - o.turn_started_at,
      });
      continue;
    }
    try {
      await port.endTurn(o.turn_id);
    } catch (err) {
      console.warn(`[finalize-stale] endTurn failed for ${o.turn_id}:`, err);
      port.log("finalize.candidate", {
        turn_id: o.turn_id,
        decision: "skip",
        reason: "end_turn_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      continue; // skip event emission — row is still in old state
    }
    ended++;
    port.log("finalize.candidate", {
      turn_id: o.turn_id,
      decision: "end",
      reason: "orphan_turn",
      age_ms: now - o.turn_started_at,
    });
    const reschedEvent = {
      type: "session.status_rescheduled",
      reason: "DO eviction or restart — stream lost; re-send to continue.",
    } as unknown as SessionEvent;
    const idleEvent = { type: "session.status_idle", stop_reason: { type: "end_turn" } } as unknown as SessionEvent;
    // Events are best-effort post-cleanup; row is the source of truth.
    try { await port.append(reschedEvent); } catch {}
    try { port.broadcast(reschedEvent); } catch {}
    try { await port.append(idleEvent); } catch {}
    try { port.broadcast(idleEvent); } catch {}
  }
  if (heldForFreshGrace > 0) {
    // A fetch()-driven cold-start pass is fire-and-forget; make sure a
    // later pass exists to re-check the in-incarnation grace window. The
    // multiplexer merges this with any heartbeat/schedule wake instead of
    // clobbering it.
    try {
      await port.scheduleGraceRetry(now + FRESH_TURN_GRACE_MS);
    } catch { /* storage alarm unavailable — alarm() path will rearm */ }
  }

  // 3. Markerless dangling-turn fallback. The pre-fix outbox path emitted
  //    session.status_running without writing sessions.turn_id, so a
  //    cold alarm saw listOrphanTurns() === [] and ended nothing. The
  //    event log is the only remaining evidence for those sessions (the
  //    exact live incident: status_running + span.model_request_start,
  //    all outbox rows completed). Close that shape too so a cold alarm
  //    flips the status back to idle.
  //
  //    Guarded by "no live work in this incarnation" plus a 5s age and
  //    an instance-start check: a turn that is merely starting in the
  //    current isolate must never be mistaken for this isolate's
  //    predecessor. D1-marked turns were already handled above.
  let markerlessEnded = 0;
  if (
    // Only when no D1-marked turn was seen at all: a markerless row is
    // one the old outbox path never stamped. If a D1 orphan existed but
    // endTurn transiently failed, leave it to the next alarm instead of
    // emitting a terminal idle for a row that still says running.
    orphans.length === 0 &&
    !port.hasLiveWork()
  ) {
    const latest = port.latestSessionStatus();
    const startedAtMs = latest === null ? 0 : latest.ts * 1000;
    if (
      latest?.type === "session.status_running" &&
      startedAtMs < port.instanceStartedAt &&
      now - startedAtMs >= 5_000
    ) {
      // Best-effort row cleanup for the markerless shape. Scoped to
      // turn_id IS NULL so it can never clobber a fresh beginTurn.
      const rowChanged = await port.clearMarkerlessTurn(now);
      if (!rowChanged) {
        // Nothing to end (a concurrent beginTurn won the race, or the
        // row was already settled). Do not emit a terminal idle for a
        // turn that is still live.
        port.log("finalize.candidate", {
          decision: "skip",
          reason: "markerless_row_not_running",
          status_ts: startedAtMs,
        });
      } else {
        const reschedEvent = {
          type: "session.status_rescheduled",
          reason: "DO eviction or restart — stream lost; re-send to continue.",
        } as unknown as SessionEvent;
        const idleEvent = { type: "session.status_idle", stop_reason: { type: "end_turn" } } as unknown as SessionEvent;
        try { await port.append(reschedEvent); } catch {}
        try { port.broadcast(reschedEvent); } catch {}
        try { await port.append(idleEvent); } catch {}
        try { port.broadcast(idleEvent); } catch {}
        markerlessEnded = 1;
        port.log("finalize.candidate", {
          decision: "end",
          reason: "markerless_dangling_turn",
          status_ts: startedAtMs,
        });
      }
    }
  }
  if (flushed > 0 || ended > 0 || markerlessEnded > 0) {
    console.log(`[finalize-stale] flushed ${flushed} tool_uses, ended ${ended + markerlessEnded} stale turns`);
    port.log("finalize.done", {
      flushed_tool_uses: flushed,
      ended_turns: ended + markerlessEnded,
      markerless_turns: markerlessEnded,
    });
  }
}
