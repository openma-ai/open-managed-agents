import type { Event } from "../../lib/events";

/**
 * Resolve an event's wall-clock time in milliseconds.
 *
 * Prefer client/server `ts` (ISO or legacy unix seconds). OpenMA
 * `occurred_at` is also accepted. CMA `processed_at` is intentionally
 * ignored — GUI timing must not depend on Managed queue fields.
 */
export function eventTsMs(e: Event): number {
  const occurred =
    (e as { occurred_at?: unknown }).occurred_at ??
    (e.data as { occurred_at?: unknown } | undefined)?.occurred_at;
  if (typeof occurred === "string") {
    const t = Date.parse(occurred);
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
