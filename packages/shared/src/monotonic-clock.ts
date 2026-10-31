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
}

export function createMonotonicClock(now: () => number = Date.now): MonotonicClock {
  let last = -Infinity;
  const nowMs = () => {
    const t = now();
    last = t > last ? t : last + 1;
    return last;
  };
  return { nowMs, nowIso: () => new Date(nowMs()).toISOString() };
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
