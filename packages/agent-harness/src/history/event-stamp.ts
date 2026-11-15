import type { SessionEvent } from "@open-managed-agents/shared";
import { generateEventId } from "@open-managed-agents/shared";

/**
 * Stamp an event with id and processed_at if not already set.
 *
 * AMA spec: `processed_at` is null until the agent actually processes the
 * event. For inbound user-side events (user.message / user.tool_confirmation /
 * user.custom_tool_result) that means "drained from the queue and handed to
 * the model", which happens later in `SessionDO.drainEventQueue`. For all
 * other events (agent output, tool output, system, lifecycle) the act of
 * appending IS the processing, so we stamp at append time.
 */
/** Optional clock for append-time processed_at (SessionDO passes its monotonic clock). */
export type HistoryStampClock = { nowIso(): string };

function stampWith(
  event: SessionEvent,
  clock: HistoryStampClock | undefined,
  pendingUntilDrain: boolean,
): SessionEvent {
  if (!event.id) {
    event.id = generateEventId();
  }
  if (!event.processed_at && !pendingUntilDrain) {
    event.processed_at = clock ? clock.nowIso() : new Date().toISOString();
  }
  return event;
}

export function stampEvent(event: SessionEvent, clock?: HistoryStampClock): SessionEvent {
  const isPendingUntilDrain =
    event.type === "user.message" ||
    event.type === "user.tool_confirmation" ||
    event.type === "user.custom_tool_result";
  return stampWith(event, clock, isPendingUntilDrain);
}

export function stampEventImmediate(event: SessionEvent, clock?: HistoryStampClock): SessionEvent {
  return stampWith(event, clock, false);
}
