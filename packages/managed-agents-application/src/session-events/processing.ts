import type { SessionEventView } from "@open-managed-agents/domain/sessions";
import type { SessionEventProcessingStore } from "@open-managed-agents/session-event-store";
import { isQueuedSessionEventType } from "./application";

export interface MarkSessionEventsProcessedCommand {
  workspaceId: string;
  sessionId: string;
  eventIds: string[];
  processedAt: string;
}

export interface SessionEventsProcessedSink {
  /** Re-emit the stamped events (same ids) on the live Session stream. */
  emit(events: SessionEventView[]): void | Promise<void>;
}

/**
 * Shared "the runtime processed these queued inputs" step used by every
 * runtime host (Cloudflare SessionDO, Node runtime). Stamps `processedAt` on
 * queued inputs exactly once and returns the events that changed so the host
 * re-emits them, with the same id, on its live stream. Inputs processed on
 * receipt and already-stamped events are left alone and not re-emitted.
 */
export async function markSessionEventsProcessed(
  store: SessionEventProcessingStore,
  command: MarkSessionEventsProcessedCommand,
  sink?: SessionEventsProcessedSink,
): Promise<SessionEventView[]> {
  if (command.eventIds.length === 0) return [];
  if (Number.isNaN(Date.parse(command.processedAt))) {
    throw new Error(`Invalid processing time: ${command.processedAt}`);
  }
  const marked = await store.markProcessed(command);
  const changed = marked.filter((event) =>
    isQueuedSessionEventType(event.type) &&
    event.processedAt === command.processedAt
  );
  if (sink !== undefined && changed.length > 0) await sink.emit(changed);
  return changed;
}
