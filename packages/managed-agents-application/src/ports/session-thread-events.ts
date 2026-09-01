import type {
  SessionEventDeltaType,
  SessionEventView,
  StreamSessionEvent,
} from "./session-events";

export interface ListSessionThreadEventsQuery {
  sessionId: string;
  threadId: string;
  pageSize?: number;
  cursor?: string;
}

export interface SessionThreadEventsPage {
  events: SessionEventView[];
  nextCursor: string | null;
}

export interface StreamSessionThreadEventsQuery {
  sessionId: string;
  threadId: string;
  deltaEventTypes?: SessionEventDeltaType[];
}

export type ListSessionThreadEventsResult =
  | { type: "page"; page: SessionThreadEventsPage }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export type StreamSessionThreadEventsResult =
  | { type: "stream"; events: AsyncIterable<StreamSessionEvent> }
  | { type: "not_found" };

export interface SessionThreadEventsApplicationPort {
  listSessionThreadEvents(query: ListSessionThreadEventsQuery): Promise<ListSessionThreadEventsResult>;
  streamSessionThreadEvents(query: StreamSessionThreadEventsQuery): Promise<StreamSessionThreadEventsResult>;
}
