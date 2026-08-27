import type {
  DeleteFileRecordResult,
  FileLocation,
  FileRecord,
  FileStore,
  InsertFileRecord,
  ListFileRecords,
} from "@open-managed-agents/file-store";

function key(workspaceId: string, fileId: string): string {
  return `${workspaceId}\u0000${fileId}`;
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function compareNewest(left: FileRecord, right: FileRecord): number {
  return right.createdAt.localeCompare(left.createdAt)
    || right.id.localeCompare(left.id);
}

export class MemoryFileStore implements FileStore {
  private readonly records = new Map<string, FileRecord>();

  async insert(input: InsertFileRecord): Promise<FileRecord> {
    const recordKey = key(input.workspaceId, input.file.id);
    if (this.records.has(recordKey)) {
      throw new Error(`File ${input.file.id} already exists`);
    }
    const stored = clone(input.file);
    this.records.set(recordKey, stored);
    return clone(stored);
  }

  async find(input: FileLocation): Promise<FileRecord | null> {
    const record = this.records.get(key(input.workspaceId, input.fileId));
    return record === undefined ? null : clone(record);
  }

  async list(input: ListFileRecords): Promise<FileRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("File list limit must be a positive integer");
    }
    const workspacePrefix = `${input.workspaceId}\u0000`;
    const position = input.position === undefined
      ? undefined
      : this.records.get(key(input.workspaceId, input.position.fileId));
    if (input.position !== undefined && position === undefined) return [];
    const records = [...this.records.entries()]
      .filter(([recordKey]) => recordKey.startsWith(workspacePrefix))
      .map(([, record]) => record)
      .filter((record) =>
        input.scopeId === undefined || record.scope?.id === input.scopeId)
      .filter((record) => {
        if (position === undefined || input.position === undefined) return true;
        const comparison = compareNewest(record, position);
        return input.position.direction === "after"
          ? comparison > 0
          : comparison < 0;
      })
      .sort(compareNewest);
    const page = input.position?.direction === "before"
      ? records.slice(-input.limit)
      : records.slice(0, input.limit);
    return page.map(clone);
  }

  async delete(input: FileLocation): Promise<DeleteFileRecordResult> {
    return this.records.delete(key(input.workspaceId, input.fileId))
      ? { type: "deleted" }
      : { type: "not_found" };
  }
}
