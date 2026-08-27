import type { SessionThread } from "@open-managed-agents/domain/sessions";
import type {
  ArchiveSessionThread,
  ArchiveSessionThreadResult,
  InsertSessionThread,
  ListSessionThreads,
  SessionThreadLocation,
  SessionThreadStore,
} from "@open-managed-agents/session-thread-store";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareThreads(left: SessionThread, right: SessionThread): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

function isAfterPosition(
  thread: SessionThread,
  position: { createdAt: string; threadId: string },
): boolean {
  return thread.createdAt.localeCompare(position.createdAt) > 0
    || (thread.createdAt === position.createdAt && thread.id > position.threadId);
}

export class MemorySessionThreadStore implements SessionThreadStore {
  private readonly workspaces = new Map<
    string,
    Map<string, Map<string, SessionThread>>
  >();
  async insert(input: InsertSessionThread): Promise<SessionThread> {
    const records = this.threads(
      input.workspaceId,
      input.thread.sessionId,
      true,
    );
    if (records.has(input.thread.id)) {
      throw new Error(`Session Thread ${input.thread.id} already exists`);
    }
    records.set(input.thread.id, clone(input.thread));
    return clone(input.thread);
  }

  async list(input: ListSessionThreads): Promise<SessionThread[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Session Thread list limit must be a positive integer");
    }
    return [...(
      this.threads(input.workspaceId, input.sessionId)?.values() ?? []
    )]
      .filter((candidate) =>
        input.position === undefined || isAfterPosition(candidate, input.position)
      )
      .sort(compareThreads)
      .slice(0, input.limit)
      .map(clone);
  }

  async find(input: SessionThreadLocation): Promise<SessionThread | null> {
    const value = this.threads(input.workspaceId, input.sessionId)?.get(
      input.threadId,
    );
    return value === undefined ? null : clone(value);
  }

  async archive(
    input: ArchiveSessionThread,
  ): Promise<ArchiveSessionThreadResult> {
    const records = this.threads(input.workspaceId, input.sessionId);
    if (records === undefined) return { type: "not_found" };
    const current = records.get(input.threadId);
    if (current === undefined) return { type: "not_found" };
    if (current.archivedAt !== null) {
      return {
        type: "archived",
        thread: clone(current),
        transitioned: false,
      };
    }
    const archived: SessionThread = {
      ...current,
      archivedAt: input.archivedAt,
      updatedAt: input.archivedAt,
    };
    records.set(input.threadId, archived);
    return {
      type: "archived",
      thread: clone(archived),
      transitioned: true,
    };
  }

  private threads(
    workspaceId: string,
    sessionId: string,
    create: true,
  ): Map<string, SessionThread>;
  private threads(
    workspaceId: string,
    sessionId: string,
    create?: false,
  ): Map<string, SessionThread> | undefined;
  private threads(
    workspaceId: string,
    sessionId: string,
    create = false,
  ): Map<string, SessionThread> | undefined {
    let sessions = this.workspaces.get(workspaceId);
    if (sessions === undefined) {
      if (!create) return undefined;
      sessions = new Map();
      this.workspaces.set(workspaceId, sessions);
    }
    const current = sessions.get(sessionId);
    if (current !== undefined || !create) return current;
    const records = new Map<string, SessionThread>();
    sessions.set(sessionId, records);
    return records;
  }
}
