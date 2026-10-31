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
  type?: unknown;
  delivery?: unknown;
  data?: { delivery?: unknown } | null;
};

function deliveryOf(event: UpsertableEvent): "queued" | "processed" | "other" {
  if (event.type === "turn.queued") return "queued";
  const d = event.delivery ?? event.data?.delivery;
  if (d === "queued") return "queued";
  if (d === "processed") return "processed";
  return "other";
}

/**
 * Apply an incoming GUI event (post-decode) to the canonical event list.
 *
 * Same-id upgrades: `turn.queued` / `delivery:queued` → `user.message` /
 * `delivery:processed` replace and re-position at the end (official CMA
 * ordering after a mid-turn queue). Never consults CMA `processed_at`.
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
  const existingDelivery = deliveryOf(existing);
  const incomingDelivery = deliveryOf(incoming);
  const upgraded =
    existingDelivery === "queued" && incomingDelivery === "processed";
  const typeUpgraded =
    existing.type === "turn.queued" && incoming.type === "user.message";

  if (!upgraded && !typeUpgraded) {
    // Same key without a queue→processed upgrade: treat as duplicate so we
    // never downgrade a processed event back to queued.
    return { events: events as T[], action: "duplicate" };
  }

  const next = events.filter((_, i) => i !== index).concat(incoming);
  return { events: next, action: "update" };
}
