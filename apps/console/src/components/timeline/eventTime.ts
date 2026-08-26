import type { Event } from "../../lib/events";

/**
 * Resolve an event's wall-clock time in milliseconds.
 *
 * Prefer `processed_at` (ISO, set by SessionDO). Fall back to `ts`, which
 * may be an ISO string (console Event type) or legacy unix seconds (number).
 */
export function eventTsMs(e: Event): number {
  const pa =
    (e as { processed_at?: unknown }).processed_at ??
    (e.data as { processed_at?: unknown } | undefined)?.processed_at;
  if (typeof pa === "string") {
    const t = Date.parse(pa);
    if (Number.isFinite(t)) return t;
  }
  if (typeof e.ts === "number") {
    // Legacy unix seconds (sub-second precision collapsed).
    return e.ts * 1000;
  }
  if (typeof e.ts === "string") {
    const iso = Date.parse(e.ts);
    if (Number.isFinite(iso)) return iso;
    const n = Number(e.ts);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  }
  return 0;
}

/**
 * Whether a turn card should be expanded.
 * Auto: only the latest turn. Explicit user overrides win.
 */
export function resolveTurnExpanded(
  turnId: string,
  latestTurnId: string | undefined,
  overrides: Record<string, boolean>,
): boolean {
  if (Object.prototype.hasOwnProperty.call(overrides, turnId)) {
    return overrides[turnId]!;
  }
  return turnId === latestTurnId;
}
