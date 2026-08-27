import type {
  ArchiveMemoryStoreRecord,
  ArchiveMemoryStoreRecordResult,
  DeleteMemoryStoreRecordResult,
  InsertMemoryStore,
  ListMemoryStoreRecords,
  MemoryStoreLocation,
  MemoryStoreStore,
  ReplaceMemoryStore,
  ReplaceMemoryStoreResult,
  StoredMemoryStore,
} from "@open-managed-agents/memory-store-store";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class InMemoryMemoryStoreStore implements MemoryStoreStore {
  private readonly workspaces = new Map<
    string,
    Map<string, StoredMemoryStore>
  >();

  private workspace(
    workspaceId: string,
    create: boolean,
  ): Map<string, StoredMemoryStore> | undefined {
    let workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined && create) {
      workspace = new Map();
      this.workspaces.set(workspaceId, workspace);
    }
    return workspace;
  }

  async insert(input: InsertMemoryStore): Promise<StoredMemoryStore> {
    const records = this.workspace(input.workspaceId, true)!;
    if (records.has(input.memoryStore.id)) {
      throw new Error(`Memory store ${input.memoryStore.id} already exists`);
    }
    const record = { memoryStore: clone(input.memoryStore), revision: 1 };
    records.set(input.memoryStore.id, record);
    return clone(record);
  }

  async find(input: MemoryStoreLocation): Promise<StoredMemoryStore | null> {
    const record = this.workspace(input.workspaceId, false)
      ?.get(input.memoryStoreId);
    return record === undefined ? null : clone(record);
  }

  async replace(
    input: ReplaceMemoryStore,
  ): Promise<ReplaceMemoryStoreResult> {
    if (input.next.id !== input.memoryStoreId) {
      throw new Error("Replacement memory store ID does not match the target");
    }
    const records = this.workspace(input.workspaceId, false);
    const current = records?.get(input.memoryStoreId);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict",
        actualRevision: current.revision,
      };
    }
    const record = {
      memoryStore: clone(input.next),
      revision: current.revision + 1,
    };
    records?.set(input.memoryStoreId, record);
    return { type: "replaced", record: clone(record) };
  }

  async archive(
    input: ArchiveMemoryStoreRecord,
  ): Promise<ArchiveMemoryStoreRecordResult> {
    const records = this.workspace(input.workspaceId, false);
    const current = records?.get(input.memoryStoreId);
    if (current === undefined) return { type: "not_found" };
    const record = {
      memoryStore: {
        ...clone(current.memoryStore),
        archivedAt: input.archivedAt,
        updatedAt: input.archivedAt,
      },
      revision: current.revision + 1,
    };
    records?.set(input.memoryStoreId, record);
    return { type: "archived", record: clone(record) };
  }

  async delete(
    input: MemoryStoreLocation,
  ): Promise<DeleteMemoryStoreRecordResult> {
    const records = this.workspace(input.workspaceId, false);
    if (records?.delete(input.memoryStoreId) !== true) {
      return { type: "not_found" };
    }
    return { type: "deleted" };
  }

  async list(input: ListMemoryStoreRecords): Promise<StoredMemoryStore[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Memory store list limit must be a positive integer");
    }
    return [...(this.workspace(input.workspaceId, false)?.values() ?? [])]
      .filter((record) =>
        input.includeArchived || record.memoryStore.archivedAt === null)
      .filter((record) =>
        input.createdAtOrAfter === undefined
        || record.memoryStore.createdAt >= input.createdAtOrAfter)
      .filter((record) =>
        input.createdAtOrBefore === undefined
        || record.memoryStore.createdAt <= input.createdAtOrBefore)
      .filter((record) =>
        input.position === undefined
        || record.memoryStore.createdAt > input.position.createdAt
        || (record.memoryStore.createdAt === input.position.createdAt
          && record.memoryStore.id > input.position.memoryStoreId))
      .sort((left, right) =>
        left.memoryStore.createdAt.localeCompare(right.memoryStore.createdAt)
        || left.memoryStore.id.localeCompare(right.memoryStore.id))
      .slice(0, input.limit)
      .map(clone);
  }
}
