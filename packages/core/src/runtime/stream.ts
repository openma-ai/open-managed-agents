import type {
  SessionEventDeltaType,
  Session,
  StreamSessionEvent,
} from "../domain/sessions/index.js";

export interface SubscribeSessionEvents {
  workspaceId: string;
  sessionId: string;
  session: Session;
  deltaEventTypes?: SessionEventDeltaType[];
}

export interface SessionEventStreamPort {
  subscribe(input: SubscribeSessionEvents): AsyncIterable<StreamSessionEvent>;
}
