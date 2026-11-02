import type {
  SentSessionEvent,
  SessionEventView,
  Session,
} from "@open-managed-agents/domain/sessions";

export interface AppendSessionEvents {
  workspaceId: string;
  sessionId: string;
  expectedRevision: number;
  events: SentSessionEvent[];
  nextSession: Session;
}

export type AppendSessionEventsResult =
  | { type: "appended"; events: SentSessionEvent[]; session: Session }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface SessionEventLogStore {
  append(input: AppendSessionEvents): Promise<AppendSessionEventsResult>;
  list(input: ListPersistedSessionEvents): Promise<SessionEventView[]>;
}

export interface SessionEventListPosition {
  processedAt: string;
  eventId: string;
}

export interface ListPersistedSessionEvents {
  workspaceId: string;
  sessionId: string;
  limit: number;
  order: "asc" | "desc";
  createdAfter?: string;
  createdAtOrAfter?: string;
  createdBefore?: string;
  createdAtOrBefore?: string;
  types?: string[];
  /** Match complete native event IDs within this workspace and session. */
  eventIds?: string[];
  position?: SessionEventListPosition;
}

export interface SessionThreadEventListPosition {
  processedAt: string;
  eventId: string;
}

export interface ListPersistedSessionThreadEvents {
  workspaceId: string;
  sessionId: string;
  threadId: string;
  limit: number;
  position?: SessionThreadEventListPosition;
}

export interface SessionThreadEventStore {
  listThread(
    input: ListPersistedSessionThreadEvents,
  ): Promise<SessionEventView[]>;
}

/** Full append log plus its thread-scoped read projection. */
export interface SessionEventStore
  extends SessionEventLogStore, SessionThreadEventStore {}

export interface MarkSessionEventsProcessed {
  workspaceId: string;
  sessionId: string;
  eventIds: string[];
  /** RFC 3339 processing time to stamp on events that are still queued. */
  processedAt: string;
}

/**
 * Queued inputs (`processed_at: null`) are stamped once by the runtime when it
 * processes them. Stamping is idempotent: events that already carry a
 * processing time are returned unchanged, unknown ids are omitted. The stored
 * ordering position moves to the processing time, so ordered readers and
 * persisted stream tails observe the stamped event (same id) again.
 */
export interface SessionEventProcessingStore {
  markProcessed(input: MarkSessionEventsProcessed): Promise<SessionEventView[]>;
}

const sortTimes = new WeakMap<object, string>();

/** Record the storage ordering time of an event read from a store. */
export function rememberSessionEventSortTime<T extends object>(event: T, sortTime: string): T {
  sortTimes.set(event, sortTime);
  return event;
}

/**
 * Ordering time of a stored event: its processing time, or the acceptance time
 * a store kept for a still-queued input (whose public `processedAt` is null).
 */
export function sessionEventSortTime(
  event: { processedAt?: string | null },
): string | undefined {
  return event.processedAt ?? sortTimes.get(event);
}
