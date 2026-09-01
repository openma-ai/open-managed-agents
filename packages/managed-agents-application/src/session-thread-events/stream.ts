import type {
  SessionEventDeltaType,
  StreamSessionEvent,
} from "../domain/session-event";
import type { Session } from "../domain/session";
import type { SessionThread } from "../domain/session-thread";

export interface SubscribeSessionThreadEvents {
  workspaceId: string;
  sessionId: string;
  threadId: string;
  session: Session;
  thread: SessionThread;
  deltaEventTypes?: SessionEventDeltaType[];
}

export interface SessionThreadEventStreamPort {
  subscribe(
    input: SubscribeSessionThreadEvents,
  ): AsyncIterable<StreamSessionEvent>;
}
