import { eventKey, type EventKeyInput } from "./session-event-key";

/**
 * Result of applying an incoming event to the canonical event list.
 *
 * - append:    a new event was added at the end
 * - update:    an existing event was replaced and re-positioned
 * - duplicate: nothing changed
 */
export type SessionEventUpsertAction = "append" | "update" | "duplicate";

export interface SessionEventUpsertResult<T> {
  events: T[];
  action: SessionEventUpsertAction;
}

type UpsertableEvent = EventKeyInput & {
  processed_at?: unknown;
  data?: { processed_at?: unknown } | null;
};

function processedAt(event: UpsertableEvent): string | null {
  const value = event.processed_at ?? event.data?.processed_at;
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Apply an incoming wire event to the canonical event list.
 *
 * SSE redelivers events, and the official send response echoes the accepted
 * `user.message` that the stream later re-emits with `processed_at` set. The
 * old `seenKeys` set treated the second copy as a duplicate and dropped it,
 * leaving queued events stuck queued forever.
 *
 * Rules:
 *   - unseen key           -> append
 *   - same key, processed_at moved from null to a value (or otherwise
 *     changed to a non-null value) -> replace AND re-position at the end so
 *     the stamped event sits after the turn that was already running when
 *     it was queued (Claude Managed Agents ordering)
 *   - same key, no newer processed_at -> duplicate (do not downgrade a
 *     processed event back to queued when an older echo arrives late)
 *
 * Matching uses the same `eventKey` contract as the rest of the Console:
 * official `id` when present, content fallback for legacy unstamped events.
 */
export function upsertSessionEvent<T extends UpsertableEvent>(
  events: readonly T[],
  incoming: T,
): SessionEventUpsertResult<T> {
  const key = eventKey(incoming);
  const index = events.findIndex((event) => eventKey(event) === key);
  if (index === -1) {
    return { events: [...events, incoming], action: "append" };
  }

  const existing = events[index];
  const existingProcessedAt = processedAt(existing);
  const incomingProcessedAt = processedAt(incoming);
  const processedAtChanged =
    incomingProcessedAt !== null && incomingProcessedAt !== existingProcessedAt;

  if (!processedAtChanged) {
    return { events: events as T[], action: "duplicate" };
  }

  // Remove the queued copy, then append the stamped copy so it lands after
  // any events that arrived while it was waiting (running turn replies, etc.).
  const next = events.filter((_, i) => i !== index).concat(incoming);
  return { events: next, action: "update" };
}
