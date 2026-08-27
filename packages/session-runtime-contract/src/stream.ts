import type {
  SessionEventDeltaType,
  Session,
  StreamSessionEvent,
} from "@open-managed-agents/domain/sessions";

export interface SubscribeSessionEvents {
  workspaceId: string;
  sessionId: string;
  session: Session;
  deltaEventTypes?: SessionEventDeltaType[];
}

export interface SessionEventStreamPort {
  subscribe(input: SubscribeSessionEvents): AsyncIterable<StreamSessionEvent>;
}
