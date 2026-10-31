import type { BetaManagedAgentsSendSessionEvents } from "@anthropic-ai/sdk/resources/beta/sessions/events";

export type SendResponse = Pick<BetaManagedAgentsSendSessionEvents, "data"> | null | undefined;

export interface SendOutboxHandoff {
  /** The optimistic value currently rendered for this send. */
  localPending: string | null;
  /** The value placed into localPending when the send began. */
  optimisticText: string;
}

export interface SendOutboxHandoffResult {
  /** Accepted events that were passed to addEvent/merged into the event log. */
  merged: number;
  /** Value the optimistic slot should hold after the handoff. */
  localPending: string | null;
}

/**
 * Hand off a successful POST /v1/sessions/:id/events response to the outbox.
 *
 * The Node/Docker runtime returns the accepted user.message in
 * `response.data` and does NOT emit a `system.user_message_pending` SSE
 * frame. Merge those events into the canonical event log BEFORE clearing
 * the optimistic localPending slot, otherwise the user bubble disappears
 * until the next refresh (#398).
 *
 * Legacy Cloudflare responses can omit `data` (202/null edge). There is
 * nothing to merge in that case; clearing localPending keeps the existing
 * fallback behavior and lets the pending SSE frames populate the outbox.
 *
 * `addEvent` is the component's canonical event sink: it dedupes by
 * `eventKey`, so when the stream later redelivers the same event id it is
 * dropped instead of rendering a second bubble.
 */
export function mergeSendResponseIntoOutbox(
  response: SendResponse,
  handoff: SendOutboxHandoff,
  addEvent: (event: Record<string, unknown>) => void,
): SendOutboxHandoffResult {
  const data = Array.isArray(response?.data) ? response.data : [];
  const events: Record<string, unknown>[] = [];
  for (const event of data) {
    if (typeof event === "object" && event !== null) {
      events.push(event as unknown as Record<string, unknown>);
    }
  }

  // Merge first; the caller clears localPending from the returned value
  // only after this loop has handed every accepted event to addEvent.
  for (const event of events) addEvent(event);

  return {
    merged: events.length,
    localPending:
      handoff.localPending === handoff.optimisticText ? null : handoff.localPending,
  };
}
