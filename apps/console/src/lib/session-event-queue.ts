/**
 * OpenMA queue semantics for Console UI.
 *
 * CMA `processed_at` is intentionally not consulted here. The ingest bridge
 * (`managed-event-bridge`) maps null/stamped wire into OpenMA `turn.queued`
 * or `delivery: "queued" | "processed"`. GUI code must use those fields only.
 */

import { isOpenMAQueuedEvent } from "@openma/common/gui";

/** User event types that the official API processes on receipt (never queued). */
const PROCESSED_ON_RECEIPT = new Set([
  "user.define_outcome",
  "user.custom_tool_result",
  "user.tool_result",
]);

/** Event types whose user-facing queue state is meaningful. */
const QUEUEABLE = new Set([
  "turn.queued",
  "user.message",
  "user.interrupt",
  "user.tool_confirmation",
  "system.message",
]);

type QueueableEvent = {
  type?: unknown;
  delivery?: unknown;
  data?: { delivery?: unknown } | null;
};

/**
 * True when a GUI event is still queued under OpenMA delivery / turn.queued.
 */
export function isQueuedSessionEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as QueueableEvent;
  if (typeof candidate.type !== "string") return false;
  if (PROCESSED_ON_RECEIPT.has(candidate.type)) return false;
  if (!QUEUEABLE.has(candidate.type)) return false;
  if (candidate.type === "turn.queued") return true;
  if (candidate.delivery === "queued") return true;
  if (candidate.data?.delivery === "queued") return true;
  return isOpenMAQueuedEvent(candidate as { type?: string; data?: unknown });
}

/**
 * A turn is queued while its triggering user.message / turn.queued is queued.
 * Queued tool_confirmation / interrupt must not relabel a running turn.
 */
export function hasQueuedUserMessage(
  events: readonly { type?: unknown; delivery?: unknown; data?: { delivery?: unknown } | null }[],
): boolean {
  return events.some(
    (event) =>
      (event?.type === "user.message" || event?.type === "turn.queued") &&
      isQueuedSessionEvent(event),
  );
}
