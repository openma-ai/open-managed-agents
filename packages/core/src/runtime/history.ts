import type {
  SessionBootstrapEvent,
  SessionEventView,
} from "../domain/sessions/index.js";

export interface LoadSessionRuntimeHistoryRecord {
  workspaceId: string;
  sessionId: string;
}

export interface SessionRuntimeHistoryRecord {
  /** Native Session revision read in the same snapshot as this history. */
  revision?: number;
  initialEvents: SessionBootstrapEvent[];
  events: SessionEventView[];
  /** Present only when every persisted event has a unique, trusted source position. */
  orderedEvents?: OrderedSessionEvent[];
}

export interface SessionRuntimeHistorySourcePort {
  load(
    input: LoadSessionRuntimeHistoryRecord,
  ): Promise<SessionRuntimeHistoryRecord | null>;
}

/** Position assigned atomically by the existing Session revision CAS. */
export interface SessionEventSourcePosition {
  revision: number;
  index: number;
}

export interface OrderedSessionEvent {
  event: SessionEventView;
  position: SessionEventSourcePosition;
  executionId?: string;
}
