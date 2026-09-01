import type {
  AgentRecord,
  AgentStore,
  ArchiveAgentRecord,
  ArchiveAgentRecordResult,
  FindAgentVersionRecord,
  FindCurrentAgentRecord,
  InsertAgentRecord,
  ListAgentRecords,
  ListAgentVersionRecords,
  ReplaceAgentRecord,
  ReplaceAgentRecordResult,
} from "@open-managed-agents/agent-store";

function currentKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}\u0000${agentId}`;
}

function versionKey(
  workspaceId: string,
  agentId: string,
  version: number,
): string {
  return `${currentKey(workspaceId, agentId)}\u0000${version}`;
}

function clone(record: AgentRecord): AgentRecord {
  return structuredClone(record);
}

function compareCurrent(left: AgentRecord, right: AgentRecord): number {
  const byCreatedAt = right.createdAt.localeCompare(left.createdAt);
  return byCreatedAt === 0 ? right.id.localeCompare(left.id) : byCreatedAt;
}

export class MemoryAgentStore implements AgentStore {
  private readonly current = new Map<string, AgentRecord>();
  private readonly versions = new Map<string, AgentRecord>();

  async insert(input: InsertAgentRecord): Promise<AgentRecord> {
    const key = currentKey(input.workspaceId, input.agent.id);
    if (this.current.has(key)) {
      throw new Error(`Agent ${input.agent.id} already exists`);
    }
    const stored = clone(input.agent);
    this.current.set(key, stored);
    return clone(stored);
  }

  async findCurrent(input: FindCurrentAgentRecord): Promise<AgentRecord | null> {
    const record = this.current.get(currentKey(input.workspaceId, input.agentId));
    return record === undefined ? null : clone(record);
  }

  async findVersion(input: FindAgentVersionRecord): Promise<AgentRecord | null> {
    const record = this.versions.get(
      versionKey(input.workspaceId, input.agentId, input.version),
    );
    return record === undefined ? null : clone(record);
  }

  async replaceCurrent(
    input: ReplaceAgentRecord,
  ): Promise<ReplaceAgentRecordResult> {
    if (input.next.id !== input.agentId) {
      throw new Error("Replacement agent ID does not match the target agent");
    }
    if (input.next.version !== input.expectedVersion + 1) {
      throw new Error("Replacement agent version must increment by exactly one");
    }
    const key = currentKey(input.workspaceId, input.agentId);
    const current = this.current.get(key);
    if (current === undefined) return { type: "not_found" };
    if (current.archivedAt !== null || current.version !== input.expectedVersion) {
      return { type: "version_conflict", actualVersion: current.version };
    }
    const previous = clone(current);
    const next = clone(input.next);
    this.versions.set(
      versionKey(input.workspaceId, input.agentId, previous.version),
      previous,
    );
    this.current.set(key, next);
    return { type: "replaced", agent: clone(next) };
  }

  async archiveCurrent(
    input: ArchiveAgentRecord,
  ): Promise<ArchiveAgentRecordResult> {
    const key = currentKey(input.workspaceId, input.agentId);
    const current = this.current.get(key);
    if (current === undefined) return { type: "not_found" };
    const archived = clone({
      ...current,
      archivedAt: input.archivedAt,
      updatedAt: input.archivedAt,
    });
    this.current.set(key, archived);
    return { type: "archived", agent: clone(archived) };
  }

  async listCurrent(input: ListAgentRecords): Promise<AgentRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Agent list limit must be a positive integer");
    }
    return [...this.current.entries()]
      .filter(([key]) => key.startsWith(`${input.workspaceId}\u0000`))
      .map(([, record]) => record)
      .filter((record) => input.includeArchived || record.archivedAt === null)
      .filter((record) =>
        input.createdAtOrAfter === undefined
          || record.createdAt >= input.createdAtOrAfter)
      .filter((record) =>
        input.createdAtOrBefore === undefined
          || record.createdAt <= input.createdAtOrBefore)
      .filter((record) => {
        if (input.after === undefined) return true;
        return record.createdAt < input.after.createdAt
          || (record.createdAt === input.after.createdAt
            && record.id < input.after.agentId);
      })
      .sort(compareCurrent)
      .slice(0, input.limit)
      .map(clone);
  }

  async listVersions(input: ListAgentVersionRecords): Promise<AgentRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Agent versions limit must be a positive integer");
    }
    const prefix = `${currentKey(input.workspaceId, input.agentId)}\u0000`;
    return [...this.versions.entries()]
      .filter(([key, record]) =>
        key.startsWith(prefix) && record.version < input.beforeVersion)
      .map(([, record]) => record)
      .sort((left, right) => right.version - left.version)
      .slice(0, input.limit)
      .map(clone);
  }
}
