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
  /** True when the response carried no accepted events to merge. */
  missingData: boolean;
}

/**
 * Hand off the official Managed Agents POST /v1/sessions/:id/events response
 * to the outbox.
 *
 * Under the official MA contract the response returns the accepted
 * `user.message` event(s) in `response.data`. Merge those events into the
 * canonical event log BEFORE clearing the optimistic `localPending` slot,
 * otherwise the user bubble disappears until the next refresh (#398).
 *
 * Empty or missing `data` is unexpected under the official MA contract.
 * When there is nothing to merge, keep the optimistic bubble as-is instead
 * of clearing it: clearing would reintroduce the #398 blank-window
 * regression, and the Console does not fall back to OpenMA's optional
 * `system.user_message_pending` stream frames to repopulate the outbox.
 * A refresh or retry is the recovery path.
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
    // Only clear the optimistic slot once accepted events are in the log.
    // With no data, keep the bubble visible rather than waiting on
    // optional pending frames.
    localPending:
      events.length > 0 && handoff.localPending === handoff.optimisticText
        ? null
        : handoff.localPending,
    missingData: events.length === 0,
  };
}
