import type { StreamSessionEvent } from "@open-managed-agents/domain/sessions";

export interface SessionRealtimeScope {
  workspaceId: string;
  sessionId: string;
}

export interface SessionRealtimeFrame {
  event: StreamSessionEvent;
  sequence?: number;
}

export interface SessionRealtimeWriter {
  readonly closed: boolean;
  write(frame: SessionRealtimeFrame): void;
  close(): void;
}

export interface AttachSessionRealtimeWriter extends SessionRealtimeScope {
  writer: SessionRealtimeWriter;
  replay?: readonly SessionRealtimeFrame[];
}

export interface PublishSessionRealtimeFrame extends SessionRealtimeScope {
  frame: SessionRealtimeFrame;
}

export interface SessionRealtimeHub {
  attach(input: AttachSessionRealtimeWriter): () => void;
  publish(input: PublishSessionRealtimeFrame): void;
  closeSession(input: SessionRealtimeScope): void;
}
