import type {
  SentSessionEvent,
  SessionEventView,
} from "../domain/session-event";
import type { Session } from "../domain/session";
import type { SessionBootstrapEvent } from "../domain/session-bootstrap";

export type RuntimeProducedSessionEvent = Exclude<
  SessionEventView,
  SentSessionEvent
>;

export interface RecordSessionRuntimeEventsCommand {
  sessionId: string;
  events: RuntimeProducedSessionEvent[];
}

export type RecordSessionRuntimeEventsResult =
  | { type: "recorded"; session: Session }
  | { type: "not_found" }
  | { type: "version_conflict"; message: string };

export interface SessionRuntimeProjectionApplicationPort {
  recordSessionRuntimeEvents(
    command: RecordSessionRuntimeEventsCommand,
  ): Promise<RecordSessionRuntimeEventsResult>;
}

export interface LoadSessionRuntimeHistoryQuery {
  sessionId: string;
}

export type LoadSessionRuntimeHistoryResult =
  | {
      type: "found";
      initialEvents: SessionBootstrapEvent[];
      events: SessionEventView[];
    }
  | { type: "not_found" };

export interface SessionRuntimeHistoryApplicationPort {
  loadSessionRuntimeHistory(
    query: LoadSessionRuntimeHistoryQuery,
  ): Promise<LoadSessionRuntimeHistoryResult>;
}
