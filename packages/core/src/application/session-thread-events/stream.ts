import type {
  SessionEventDeltaType,
  StreamSessionEvent,
} from "../domain/session-event.js";
import type { Session } from "../domain/session.js";
import type { SessionThread } from "../domain/session-thread.js";

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
