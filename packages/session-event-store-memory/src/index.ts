import type {
  SentSessionEvent,
  SessionEventView,
} from "@open-managed-agents/domain/sessions";
import type {
  AppendSessionEvents,
  AppendSessionEventsResult,
  ListPersistedSessionEvents,
  ListPersistedSessionThreadEvents,
  MarkSessionEventsProcessed,
  SessionEventProcessingStore,
  SessionEventStore,
} from "@open-managed-agents/session-event-store";
import { rememberSessionEventSortTime } from "@open-managed-agents/session-event-store";
import type { SessionStore } from "@open-managed-agents/session-store";

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface StoredEvent {
  event: SessionEventView;
  /** Processing time, or acceptance time while a queued input is pending. */
  sortTime: string;
}

function processedAt(record: StoredEvent | SessionEventView): string {
  if ("sortTime" in record) return record.sortTime;
  if (record.processedAt == null) {
    throw new Error(`Session event ${record.id} has no processing time`);
  }
  return record.processedAt;
}

function idOf(record: StoredEvent | SessionEventView): string {
  return "sortTime" in record ? record.event.id : record.id;
}

function output(record: StoredEvent): SessionEventView {
  return rememberSessionEventSortTime(clone(record.event), record.sortTime);
}

function compareEvents(
  left: StoredEvent | SessionEventView,
  right: StoredEvent | SessionEventView,
): number {
  return processedAt(left).localeCompare(processedAt(right))
    || idOf(left).localeCompare(idOf(right));
}

export class MemorySessionEventStore
  implements SessionEventStore, SessionEventProcessingStore
{
  private readonly workspaces = new Map<
    string,
    Map<string, Map<string, StoredEvent>>
  >();
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly sessions: SessionStore) {}

  append(input: AppendSessionEvents): Promise<AppendSessionEventsResult> {
    return this.exclusive(async () => {
      if (input.nextSession.id !== input.sessionId) {
        throw new Error("Next Session ID does not match the event target");
      }

      const current = await this.sessions.findCurrent({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      });
      if (current === null) return { type: "not_found" };
      if (current.revision !== input.expectedRevision) {
        return {
          type: "revision_conflict",
          actualRevision: current.revision,
        };
      }
      const replaced = await this.sessions.replaceCurrent({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
        next: input.nextSession,
      });
      if (replaced.type !== "replaced") return replaced;

      const records = this.events(input.workspaceId, input.sessionId, true);
      for (const event of input.events) {
        if (!records.has(event.id)) {
          records.set(event.id, {
            event: clone(event),
            sortTime: event.processedAt ?? input.nextSession.updatedAt,
          });
        }
      }
      return {
        type: "appended",
        events: clone(input.events),
        session: clone(replaced.record.session),
      };
    });
  }

  async list(input: ListPersistedSessionEvents): Promise<SessionEventView[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Session event list limit must be a positive integer");
    }
    if (input.types !== undefined && input.types.length === 0) return [];
    const direction = input.order === "asc" ? 1 : -1;
    const position: SessionEventView | undefined = input.position === undefined
      ? undefined
      : {
          id: input.position.eventId,
          type: "agent.thinking",
          processedAt: input.position.processedAt,
        };
    return [...(this.events(input.workspaceId, input.sessionId)?.values() ?? [])]
      .filter((event) => input.createdAfter === undefined || processedAt(event) > input.createdAfter)
      .filter((event) => input.createdAtOrAfter === undefined || processedAt(event) >= input.createdAtOrAfter)
      .filter((event) => input.createdBefore === undefined || processedAt(event) < input.createdBefore)
      .filter((event) => input.createdAtOrBefore === undefined || processedAt(event) <= input.createdAtOrBefore)
      .filter((record) => input.types === undefined || input.types.includes(record.event.type))
      .filter((record) => input.eventIds === undefined || input.eventIds.includes(record.event.id))
      .filter((event) => position === undefined || direction * compareEvents(event, position) > 0)
      .sort((left, right) => direction * compareEvents(left, right))
      .slice(0, input.limit)
      .map(output);
  }

  markProcessed(input: MarkSessionEventsProcessed): Promise<SessionEventView[]> {
    return this.exclusive(async () => {
      if (Number.isNaN(Date.parse(input.processedAt))) {
        throw new Error(`Invalid session event timestamp: ${input.processedAt}`);
      }
      const records = this.events(input.workspaceId, input.sessionId);
      const out: SessionEventView[] = [];
      for (const eventId of new Set(input.eventIds)) {
        const record = records?.get(eventId);
        if (record === undefined) continue;
        if (record.event.processedAt == null) {
          record.event = { ...record.event, processedAt: input.processedAt } as SessionEventView;
          record.sortTime = input.processedAt;
        }
        out.push(output(record));
      }
      return out;
    });
  }

  async listThread(
    input: ListPersistedSessionThreadEvents,
  ): Promise<SessionEventView[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error(
        "Session Thread event list limit must be a positive integer",
      );
    }
    const position: SessionEventView | undefined = input.position === undefined
      ? undefined
      : {
          id: input.position.eventId,
          type: "agent.thinking",
          processedAt: input.position.processedAt,
        };
    return [...(this.events(input.workspaceId, input.sessionId)?.values() ?? [])]
      .filter(({ event }) =>
        "sessionThreadId" in event && event.sessionThreadId === input.threadId
      )
      .filter((event) =>
        position === undefined || compareEvents(event, position) > 0
      )
      .sort(compareEvents)
      .slice(0, input.limit)
      .map(output);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private events(
    workspaceId: string,
    sessionId: string,
    create: true,
  ): Map<string, StoredEvent>;
  private events(
    workspaceId: string,
    sessionId: string,
    create?: false,
  ): Map<string, StoredEvent> | undefined;
  private events(
    workspaceId: string,
    sessionId: string,
    create = false,
  ): Map<string, StoredEvent> | undefined {
    let sessions = this.workspaces.get(workspaceId);
    if (sessions === undefined) {
      if (!create) return undefined;
      sessions = new Map();
      this.workspaces.set(workspaceId, sessions);
    }
    const current = sessions.get(sessionId);
    if (current !== undefined || !create) return current;
    const events = new Map<string, StoredEvent>();
    sessions.set(sessionId, events);
    return events;
  }
}

export type { SentSessionEvent };
