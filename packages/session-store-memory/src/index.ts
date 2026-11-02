import type {
  ArchiveSessionRecord,
  ArchiveSessionRecordResult,
  DeleteSessionRecordResult,
  FindCurrentSessionRecord,
  InsertSessionRecord,
  ListSessionRecords,
  ReplaceSessionRecord,
  ReplaceSessionRecordResult,
  SessionStore,
  StoredSession,
} from "@open-managed-agents/session-store";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareSessions(
  left: StoredSession,
  right: StoredSession,
): number {
  return left.session.createdAt.localeCompare(right.session.createdAt)
    || left.session.id.localeCompare(right.session.id);
}

export class MemorySessionStore implements SessionStore {
  private readonly workspaces = new Map<string, Map<string, StoredSession>>();

  async insert(input: InsertSessionRecord): Promise<StoredSession> {
    const records = this.records(input.workspaceId, true);
    if (records.has(input.session.id)) {
      throw new Error(`Session ${input.session.id} already exists`);
    }
    const record: StoredSession = {
      session: clone(input.session),
      revision: 1,
    };
    records.set(input.session.id, record);
    return clone(record);
  }

  async findCurrent(
    input: FindCurrentSessionRecord,
  ): Promise<StoredSession | null> {
    const record = this.records(input.workspaceId)?.get(input.sessionId);
    return record === undefined ? null : clone(record);
  }

  async replaceCurrent(
    input: ReplaceSessionRecord,
  ): Promise<ReplaceSessionRecordResult> {
    if (input.next.id !== input.sessionId) {
      throw new Error("Replacement session ID does not match the target session");
    }
    const records = this.records(input.workspaceId);
    const current = records?.get(input.sessionId);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict",
        actualRevision: current.revision,
      };
    }
    const record: StoredSession = {
      session: clone(input.next),
      revision: current.revision + 1,
    };
    records?.set(input.sessionId, record);
    return { type: "replaced", record: clone(record) };
  }

  async archiveCurrent(
    input: ArchiveSessionRecord,
  ): Promise<ArchiveSessionRecordResult> {
    const records = this.records(input.workspaceId);
    const current = records?.get(input.sessionId);
    if (current === undefined) return { type: "not_found" };
    const record: StoredSession = {
      session: {
        ...clone(current.session),
        archivedAt: input.archivedAt,
        updatedAt: input.archivedAt,
      },
      revision: current.revision + 1,
    };
    records?.set(input.sessionId, record);
    return { type: "archived", record: clone(record) };
  }

  async deleteCurrent(
    input: FindCurrentSessionRecord,
  ): Promise<DeleteSessionRecordResult> {
    const records = this.records(input.workspaceId);
    if (records === undefined || !records.delete(input.sessionId)) {
      return { type: "not_found" };
    }
    if (records.size === 0) this.workspaces.delete(input.workspaceId);
    return { type: "deleted" };
  }

  async listCurrent(input: ListSessionRecords): Promise<StoredSession[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Session list limit must be a positive integer");
    }
    if (input.statuses !== undefined && input.statuses.length === 0) return [];

    const direction = input.order === "asc" ? 1 : -1;
    const records = [...(this.records(input.workspaceId)?.values() ?? [])]
      .filter((record) => input.includeArchived || record.session.archivedAt === null)
      .filter((record) => input.agentId === undefined || record.session.agent.id === input.agentId)
      .filter((record) => input.agentVersion === undefined || record.session.agent.version === input.agentVersion)
      .filter((record) => input.createdAfter === undefined || record.session.createdAt > input.createdAfter)
      .filter((record) => input.createdAtOrAfter === undefined || record.session.createdAt >= input.createdAtOrAfter)
      .filter((record) => input.createdBefore === undefined || record.session.createdAt < input.createdBefore)
      .filter((record) => input.createdAtOrBefore === undefined || record.session.createdAt <= input.createdAtOrBefore)
      .filter((record) => input.deploymentId === undefined || record.session.deploymentId === input.deploymentId)
      .filter((record) => input.statuses === undefined || input.statuses.includes(record.session.status))
      .filter((record) =>
        input.memoryStoreId === undefined
        || record.session.resources.some(
          (resource) => resource.type === "memory_store"
            && resource.memoryStoreId === input.memoryStoreId,
        ))
      .filter((record) => {
        if (input.position === undefined) return true;
        const position: StoredSession = {
          revision: 0,
          session: {
            ...record.session,
            id: input.position.sessionId,
            createdAt: input.position.createdAt,
          },
        };
        const comparison = direction * compareSessions(record, position);
        return input.position.direction === "next"
          ? comparison > 0
          : comparison < 0;
      })
      .sort((left, right) => {
        const requested = direction * compareSessions(left, right);
        return input.position?.direction === "previous"
          ? -requested
          : requested;
      });

    return records.slice(0, input.limit).map(clone);
  }

  private records(workspaceId: string, create: true): Map<string, StoredSession>;
  private records(
    workspaceId: string,
    create?: false,
  ): Map<string, StoredSession> | undefined;
  private records(
    workspaceId: string,
    create = false,
  ): Map<string, StoredSession> | undefined {
    const current = this.workspaces.get(workspaceId);
    if (current !== undefined || !create) return current;
    const records = new Map<string, StoredSession>();
    this.workspaces.set(workspaceId, records);
    return records;
  }
}
