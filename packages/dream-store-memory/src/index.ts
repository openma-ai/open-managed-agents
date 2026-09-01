import type {
  DreamLocation,
  DreamStore,
  InsertDreamRecord,
  ListDreamRecords,
  ReplaceDreamRecord,
  ReplaceDreamRecordResult,
  StoredDream,
} from "@open-managed-agents/dream-store";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class MemoryDreamStore implements DreamStore {
  private readonly workspaces = new Map<string, Map<string, StoredDream>>();

  private workspace(
    workspaceId: string,
    create: boolean,
  ): Map<string, StoredDream> | undefined {
    let workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined && create) {
      workspace = new Map();
      this.workspaces.set(workspaceId, workspace);
    }
    return workspace;
  }

  async insert(input: InsertDreamRecord): Promise<StoredDream> {
    const records = this.workspace(input.workspaceId, true)!;
    if (records.has(input.dream.id)) {
      throw new Error(`Dream ${input.dream.id} already exists`);
    }
    const stored = { dream: clone(input.dream), revision: 1 };
    records.set(input.dream.id, stored);
    return clone(stored);
  }

  async find(input: DreamLocation): Promise<StoredDream | null> {
    const record = this.workspace(input.workspaceId, false)?.get(input.dreamId);
    return record === undefined ? null : clone(record);
  }

  async list(input: ListDreamRecords): Promise<StoredDream[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Dream list limit must be a positive integer");
    }
    return [...(this.workspace(input.workspaceId, false)?.values() ?? [])]
      .filter((record) =>
        input.includeArchived || record.dream.archivedAt === null)
      .filter((record) =>
        input.statuses === undefined || input.statuses.length === 0
        || input.statuses.includes(record.dream.status))
      .filter((record) =>
        input.createdAfter === undefined
        || record.dream.createdAt > input.createdAfter)
      .filter((record) =>
        input.createdBefore === undefined
        || record.dream.createdAt < input.createdBefore)
      .filter((record) =>
        input.position === undefined
        || record.dream.createdAt < input.position.createdAt
        || (record.dream.createdAt === input.position.createdAt
          && record.dream.id < input.position.dreamId))
      .sort((left, right) =>
        right.dream.createdAt.localeCompare(left.dream.createdAt)
        || right.dream.id.localeCompare(left.dream.id))
      .slice(0, input.limit)
      .map(clone);
  }

  async replace(
    input: ReplaceDreamRecord,
  ): Promise<ReplaceDreamRecordResult> {
    if (input.next.id !== input.dreamId) {
      throw new Error("Replacement Dream identity does not match its target");
    }
    const records = this.workspace(input.workspaceId, false);
    const current = records?.get(input.dreamId);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict",
        actualRevision: current.revision,
      };
    }
    const record = {
      dream: clone(input.next),
      revision: current.revision + 1,
    };
    records?.set(input.dreamId, record);
    return { type: "replaced", record: clone(record) };
  }
}
