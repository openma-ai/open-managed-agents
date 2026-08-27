import type { Session } from "../domain/session";
import type { SessionThread } from "../domain/session-thread";

export interface FindSessionThreadContext {
  workspaceId: string;
  sessionId: string;
  threadId: string;
}

export interface SessionThreadContext {
  session: Session;
  thread: SessionThread;
}

export interface SessionThreadSourcePort {
  find(input: FindSessionThreadContext): Promise<SessionThreadContext | null>;
}
