import type {
  SessionThread,
  SessionThreadAgent,
  SessionThreadStats,
} from "../domain/session-thread";

export type SessionThreadAgentView = SessionThreadAgent;
export type SessionThreadStatsView = SessionThreadStats;
export type SessionThreadView = SessionThread;

export interface ListSessionThreadsQuery {
  sessionId: string;
  pageSize?: number;
  cursor?: string;
}

export interface SessionThreadsPage {
  threads: SessionThreadView[];
  nextCursor: string | null;
}

export interface RetrieveSessionThreadQuery {
  sessionId: string;
  threadId: string;
}

export interface ArchiveSessionThreadCommand {
  sessionId: string;
  threadId: string;
}

export type ListSessionThreadsResult =
  | { type: "page"; page: SessionThreadsPage }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export type RetrieveSessionThreadResult =
  | { type: "found"; thread: SessionThreadView }
  | { type: "not_found" };

export type ArchiveSessionThreadResult =
  | { type: "archived"; thread: SessionThreadView }
  | { type: "not_found" };

export interface SessionThreadsApplicationPort {
  listSessionThreads(query: ListSessionThreadsQuery): Promise<ListSessionThreadsResult>;
  retrieveSessionThread(query: RetrieveSessionThreadQuery): Promise<RetrieveSessionThreadResult>;
  archiveSessionThread(command: ArchiveSessionThreadCommand): Promise<ArchiveSessionThreadResult>;
}
