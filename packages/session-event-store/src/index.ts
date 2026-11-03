// Moved to @openma/core (#434). Kept so existing imports keep working.
export type * from "@openma/core/storage/session-events";

const sortTimes = new WeakMap<object, string>();

/** Record the storage ordering time of an event read from a store. */
export function rememberSessionEventSortTime<T extends object>(event: T, sortTime: string): T {
  sortTimes.set(event, sortTime);
  return event;
}

/**
 * Ordering time of a stored event: its processing time, or the acceptance time
 * a store kept for a still-queued input (whose public `processedAt` is null).
 */
export function sessionEventSortTime(
  event: { processedAt?: string | null },
): string | undefined {
  return event.processedAt ?? sortTimes.get(event);
}
