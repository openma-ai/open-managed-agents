/**
 * Official Managed Agents queue semantics for user-sent session events.
 *
 * `processed_at` is the source of truth:
 *   - null / undefined -> the event is still queued behind earlier events
 *   - a timestamp       -> the event has been processed
 *
 * A few event types are processed on receipt by contract, so they are never
 * rendered as queued even if a transport omits `processed_at`.
 *
 * Do not consult OpenMA's `processed_at_ms` / `cancelled_at_ms` extension
 * fields here: they describe a queue/cancel model the official API does not
 * have. The Console follows the official wire contract only.
 */

/** User event types that the official API processes on receipt. */
const PROCESSED_ON_RECEIPT = new Set([
  "user.define_outcome",
  "user.custom_tool_result",
  "user.tool_result",
]);

/** Event types whose user-facing queue state is meaningful. */
const QUEUEABLE = new Set([
  "user.message",
  "user.interrupt",
  "user.tool_confirmation",
  "system.message",
]);

type QueueableEvent = {
  type?: unknown;
  processed_at?: unknown;
  data?: { processed_at?: unknown } | null;
};

function processedAt(event: QueueableEvent): unknown {
  // Canonical events carry processed_at at the top level. Keep a nested
  // `data.processed_at` fallback for legacy/transport-wrapped payloads.
  return event.processed_at ?? event.data?.processed_at;
}

/**
 * True when an event is still queued under the official Managed Agents
 * contract. Events outside the queueable set (agent output, session status,
 * spans, …) and the processed-on-receipt exceptions are never queued.
 */
export function isQueuedSessionEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as QueueableEvent;
  if (typeof candidate.type !== "string") return false;
  if (PROCESSED_ON_RECEIPT.has(candidate.type)) return false;
  if (!QUEUEABLE.has(candidate.type)) return false;
  const at = processedAt(candidate);
  return at === null || at === undefined;
}

/**
 * Convenience for canonical chat turns: a turn is queued while its
 * user.message trigger is still queued. Once the same-id event is updated
 * with processed_at, the turn transitions to its normal running state.
 *
 * Deliberately scoped to user.message: a queued user.tool_confirmation or
 * user.interrupt can appear inside an already-running turn and must not
 * relabel the whole turn as queued.
 */
export function hasQueuedUserMessage(
  events: readonly { type?: unknown; processed_at?: unknown; data?: { processed_at?: unknown } | null }[],
): boolean {
  return events.some(
    (event) => event?.type === "user.message" && isQueuedSessionEvent(event),
  );
}
