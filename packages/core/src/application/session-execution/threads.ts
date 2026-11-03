import type { Session } from "../domain/session.js";
import type { SessionThread } from "../domain/session-thread.js";

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
