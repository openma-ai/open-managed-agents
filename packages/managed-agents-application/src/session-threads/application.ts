import type {
  ArchiveSessionThreadCommand,
  ArchiveSessionThreadResult,
  ListSessionThreadsQuery,
  ListSessionThreadsResult,
  RetrieveSessionThreadQuery,
  RetrieveSessionThreadResult,
  SessionThreadsApplicationPort,
} from "../ports/session-threads";
import type { Session } from "../domain/session";
import type { SessionSourcePort } from "../session-events/session-source";
import type { SessionThreadStore } from "@open-managed-agents/session-thread-store";
import type { SessionThreadLifecycleCommandPort } from "../session-execution/threads";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeThreadCursor(thread: {
  id: string;
  createdAt: string;
}): string {
  return `session-threads.${encodeCursorPart(thread.createdAt)}.${encodeCursorPart(thread.id)}`;
}

function decodeThreadCursor(
  value: string,
): { createdAt: string; threadId: string } | null {
  const [scope, createdAt, threadId, extra] = value.split(".");
  if (
    scope !== "session-threads" ||
    createdAt === undefined ||
    threadId === undefined ||
    extra !== undefined
  ) return null;
  const decodedCreatedAt = decodeCursorPart(createdAt);
  const decodedThreadId = decodeCursorPart(threadId);
  if (
    decodedCreatedAt === null ||
    decodedThreadId === null ||
    decodedThreadId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return { createdAt: decodedCreatedAt, threadId: decodedThreadId };
}

export interface SessionThreadsApplicationServiceDependencies {
  workspaceId: string;
  sessions: SessionSourcePort;
  store: SessionThreadStore;
  lifecycle: SessionThreadLifecycleCommandPort;
  clock: { now(): Date };
}

export class SessionThreadsApplicationService
  implements SessionThreadsApplicationPort
{
  constructor(
    private readonly dependencies: SessionThreadsApplicationServiceDependencies,
  ) {}

  async listSessionThreads(
    query: ListSessionThreadsQuery,
  ): Promise<ListSessionThreadsResult> {
    if ((await this.findSession(query.sessionId)) === null) return { type: "not_found" };
    const position =
      query.cursor === undefined ? undefined : decodeThreadCursor(query.cursor);
    if (position === null) {
      return {
        type: "invalid_request",
        message: "Invalid session threads page cursor",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
      limit: pageSize + 1,
      ...(position !== undefined && { position }),
    });
    const hasMore = records.length > pageSize;
    const threads = hasMore ? records.slice(0, pageSize) : records;
    const last = threads[threads.length - 1];
    return {
      type: "page",
      page: {
        threads,
        nextCursor:
          hasMore && last !== undefined ? encodeThreadCursor(last) : null,
      },
    };
  }

  async retrieveSessionThread(
    query: RetrieveSessionThreadQuery,
  ): Promise<RetrieveSessionThreadResult> {
    if ((await this.findSession(query.sessionId)) === null) return { type: "not_found" };
    const thread = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
      threadId: query.threadId,
    });
    return thread === null ? { type: "not_found" } : { type: "found", thread };
  }

  async archiveSessionThread(
    command: ArchiveSessionThreadCommand,
  ): Promise<ArchiveSessionThreadResult> {
    const session = await this.findSession(command.sessionId);
    if (session === null) return { type: "not_found" };
    const result = await this.dependencies.store.archive({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
      threadId: command.threadId,
      archivedAt: this.dependencies.clock.now().toISOString(),
    });
    if (result.type === "archived" && result.transitioned) {
      await this.dependencies.lifecycle.sessionThreadArchived({
        workspaceId: this.dependencies.workspaceId,
        sessionId: command.sessionId,
        threadId: command.threadId,
        session,
        thread: result.thread,
      });
    }
    return result.type === "not_found"
      ? result
      : { type: "archived", thread: result.thread };
  }

  private findSession(sessionId: string): Promise<Session | null> {
    return this.dependencies.sessions.find({
      workspaceId: this.dependencies.workspaceId,
      sessionId,
    });
  }
}
