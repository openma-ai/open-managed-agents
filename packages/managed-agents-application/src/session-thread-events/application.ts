import type {
  ListSessionThreadEventsQuery,
  ListSessionThreadEventsResult,
  SessionThreadEventsApplicationPort,
  StreamSessionThreadEventsQuery,
  StreamSessionThreadEventsResult,
} from "../ports/session-thread-events";
import type { SessionEventView } from "../ports/session-events";
import type { SessionThreadEventStore } from "@open-managed-agents/session-event-store";
import type { SessionThreadEventStreamPort } from "./stream";
import type {
  SessionThreadContext,
  SessionThreadSourcePort,
} from "./thread-source";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeEventCursor(event: SessionEventView): string | null {
  if (event.processedAt == null) return null;
  return `session-thread-events.${encodeCursorPart(event.processedAt)}.${encodeCursorPart(event.id)}`;
}

function decodeEventCursor(
  value: string,
): { processedAt: string; eventId: string } | null {
  const [scope, processedAt, eventId, extra] = value.split(".");
  if (
    scope !== "session-thread-events" ||
    processedAt === undefined ||
    eventId === undefined ||
    extra !== undefined
  ) return null;
  const decodedProcessedAt = decodeCursorPart(processedAt);
  const decodedEventId = decodeCursorPart(eventId);
  if (
    decodedProcessedAt === null ||
    decodedEventId === null ||
    decodedEventId.length === 0 ||
    Number.isNaN(Date.parse(decodedProcessedAt)) ||
    new Date(decodedProcessedAt).toISOString() !== decodedProcessedAt
  ) return null;
  return { processedAt: decodedProcessedAt, eventId: decodedEventId };
}

export interface SessionThreadEventsApplicationServiceDependencies {
  workspaceId: string;
  threads: SessionThreadSourcePort;
  store: SessionThreadEventStore;
  stream: SessionThreadEventStreamPort;
}

export class SessionThreadEventsApplicationService
  implements SessionThreadEventsApplicationPort
{
  constructor(
    private readonly dependencies: SessionThreadEventsApplicationServiceDependencies,
  ) {}

  async listSessionThreadEvents(
    query: ListSessionThreadEventsQuery,
  ): Promise<ListSessionThreadEventsResult> {
    if ((await this.findThreadContext(query)) === null) return { type: "not_found" };
    const position =
      query.cursor === undefined ? undefined : decodeEventCursor(query.cursor);
    if (position === null) {
      return {
        type: "invalid_request",
        message: "Invalid session thread events page cursor",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.listThread({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
      threadId: query.threadId,
      limit: pageSize + 1,
      ...(position !== undefined && { position }),
    });
    const hasMore = records.length > pageSize;
    const events = hasMore ? records.slice(0, pageSize) : records;
    const last = events[events.length - 1];
    return {
      type: "page",
      page: {
        events,
        nextCursor:
          hasMore && last !== undefined ? encodeEventCursor(last) : null,
      },
    };
  }

  async streamSessionThreadEvents(
    query: StreamSessionThreadEventsQuery,
  ): Promise<StreamSessionThreadEventsResult> {
    const context = await this.findThreadContext(query);
    if (context === null) return { type: "not_found" };
    return {
      type: "stream",
      events: this.dependencies.stream.subscribe({
        workspaceId: this.dependencies.workspaceId,
        sessionId: query.sessionId,
        threadId: query.threadId,
        session: context.session,
        thread: context.thread,
        ...(query.deltaEventTypes !== undefined && {
          deltaEventTypes: query.deltaEventTypes,
        }),
      }),
    };
  }

  private findThreadContext(input: {
    sessionId: string;
    threadId: string;
  }): Promise<SessionThreadContext | null> {
    return this.dependencies.threads.find({
      workspaceId: this.dependencies.workspaceId,
      sessionId: input.sessionId,
      threadId: input.threadId,
    });
  }
}
