import type {
  SessionBootstrapEvent,
  SessionEventView,
} from "@open-managed-agents/domain/sessions";

export interface LoadSessionRuntimeHistoryRecord {
  workspaceId: string;
  sessionId: string;
}

export interface SessionRuntimeHistoryRecord {
  initialEvents: SessionBootstrapEvent[];
  events: SessionEventView[];
}

export interface SessionRuntimeHistorySourcePort {
  load(
    input: LoadSessionRuntimeHistoryRecord,
  ): Promise<SessionRuntimeHistoryRecord | null>;
}
