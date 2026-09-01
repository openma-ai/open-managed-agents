import type { Session } from "../domain/session";
import type { SessionThread } from "../domain/session-thread";

export interface ArchivedSessionThread {
  workspaceId: string;
  sessionId: string;
  threadId: string;
  session: Session;
  thread: SessionThread;
}

export interface SessionThreadLifecycleCommandPort {
  sessionThreadArchived(input: ArchivedSessionThread): Promise<void>;
}
