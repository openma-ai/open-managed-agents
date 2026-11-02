/**
 * Per-session monotonic wall clock for `processed_at` stamps.
 *
 * Event lists are ordered by (processed_at, id). Two events stamped in the
 * same millisecond fall back to id order, and ids are random / use mixed
 * prefixes (`sevt-…` vs `sevt_…`), so causally-later events (e.g. the
 * status_idle a user.interrupt produces) could list BEFORE their cause.
 * Every stamp from one clock is strictly greater than the previous one,
 * so (processed_at) alone preserves emission order within a session.
 */
export interface MonotonicClock {
  nowMs(): number;
  nowIso(): string;
  /** Stamp from an externally supplied reading (e.g. an injected fake clock);
   * still strictly greater than every previous stamp of this clock. */
  stampMs(readingMs: number): number;
  stampIso(readingMs: number): string;
}

export function createMonotonicClock(now: () => number = Date.now): MonotonicClock {
  let last = -Infinity;
  const stampMs = (t: number) => {
    last = t > last ? t : last + 1;
    return last;
  };
  const nowMs = () => stampMs(now());
  return {
    nowMs,
    nowIso: () => new Date(nowMs()).toISOString(),
    stampMs,
    stampIso: (t: number) => new Date(stampMs(t)).toISOString(),
  };
}

const sessionClocks = new Map<string, MonotonicClock>();
const MAX_SESSION_CLOCKS = 10_000;

/**
 * Process-wide monotonic clock for one session (Node runtimes, where the
 * event log is re-created per call). Bounded LRU-ish map.
 */
export function sessionMonotonicClock(sessionId: string): MonotonicClock {
  let clock = sessionClocks.get(sessionId);
  if (clock) {
    sessionClocks.delete(sessionId);
  } else {
    clock = createMonotonicClock();
    if (sessionClocks.size >= MAX_SESSION_CLOCKS) {
      const oldest = sessionClocks.keys().next().value;
      if (oldest !== undefined) sessionClocks.delete(oldest);
    }
  }
  sessionClocks.set(sessionId, clock);
  return clock;
}

/** Registry of per-(workspace, session) clocks. */
export interface SessionClockRegistry {
  forSession(workspaceId: string, sessionId: string): MonotonicClock;
}

export function createSessionClockRegistry(maxSessions = 10_000): SessionClockRegistry {
  const clocks = new Map<string, MonotonicClock>();
  return {
    forSession(workspaceId, sessionId) {
      const key = `${workspaceId}\u0000${sessionId}`;
      let clock = clocks.get(key);
      if (clock) clocks.delete(key);
      else {
        clock = createMonotonicClock();
        if (clocks.size >= maxSessions) {
          const oldest = clocks.keys().next().value;
          if (oldest !== undefined) clocks.delete(oldest);
        }
      }
      clocks.set(key, clock);
      return clock;
    },
  };
}

/**
 * ONE per-session clock shared by every Node component that stamps
 * processed_at for a (workspace, session): the execution worker (interrupts)
 * and the managed runtime driver / harness (idle, running, agent events).
 * Callers pass their own clock reading via stampIso(reading) so injected fake
 * clocks keep working; tests inject a fresh registry.
 */
export const processSessionClocks: SessionClockRegistry = createSessionClockRegistry();
