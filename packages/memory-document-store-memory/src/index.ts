import type {
  Memory,
  MemoryVersion,
  MemoryVersionActor,
} from "@open-managed-agents/domain/memories";
import type {
  CreateMemoryRecord,
  CreateMemoryRecordResult,
  DeleteMemoryRecord,
  DeleteMemoryRecordResult,
  ListMemoryRecords,
  ListMemoryVersionRecords,
  MemoryDocumentStore,
  MemoryLocation,
  MemoryVersionLocation,
  RedactMemoryVersionRecord,
  RedactMemoryVersionRecordResult,
  ReplaceMemoryRecord,
  ReplaceMemoryRecordResult,
  StoredMemory,
  StoredMemoryListItem,
  StoredMemoryListPage,
  StoredMemoryVersion,
} from "@open-managed-agents/memory-document-store";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function actorMatches(
  actor: MemoryVersionActor,
  input: ListMemoryVersionRecords,
): boolean {
  return (
    input.apiKeyId === undefined
    || (actor.kind === "api" && actor.apiKeyId === input.apiKeyId)
  ) && (
    input.serviceAccountId === undefined
    || (actor.kind === "service_account"
      && actor.serviceAccountId === input.serviceAccountId)
  ) && (
    input.sessionId === undefined
    || (actor.kind === "session" && actor.sessionId === input.sessionId)
  );
}

function validateMutationPair(memory: Memory, version: MemoryVersion): void {
  if (
    memory.memoryVersionId !== version.id
    || memory.id !== version.memoryId
    || memory.memoryStoreId !== version.memoryStoreId
  ) {
    throw new Error("Memory and Memory Version mutation pair is inconsistent");
  }
}

export class InMemoryMemoryDocumentStore implements MemoryDocumentStore {
  private readonly memories = new Map<string, StoredMemory>();
  private readonly versions = new Map<string, StoredMemoryVersion>();

  private memoryKey(input: {
    workspaceId: string;
    memoryStoreId: string;
    memoryId: string;
  }): string {
    return `${input.workspaceId}\u0000${input.memoryStoreId}\u0000${input.memoryId}`;
  }

  private versionKey(input: {
    workspaceId: string;
    memoryStoreId: string;
    memoryVersionId: string;
  }): string {
    return `${input.workspaceId}\u0000${input.memoryStoreId}\u0000${input.memoryVersionId}`;
  }

  private findPath(input: {
    workspaceId: string;
    memoryStoreId: string;
    path: string;
    excludingMemoryId?: string;
  }): StoredMemory | null {
    for (const [key, record] of this.memories) {
      const prefix = `${input.workspaceId}\u0000${input.memoryStoreId}\u0000`;
      if (
        key.startsWith(prefix)
        && record.memory.path === input.path
        && record.memory.id !== input.excludingMemoryId
      ) return record;
    }
    return null;
  }

  async create(input: CreateMemoryRecord): Promise<CreateMemoryRecordResult> {
    validateMutationPair(input.memory, input.version);
    const conflict = this.findPath({
      workspaceId: input.workspaceId,
      memoryStoreId: input.memory.memoryStoreId,
      path: input.memory.path,
    });
    if (conflict !== null) {
      return {
        type: "path_conflict",
        conflictingMemoryId: conflict.memory.id,
        conflictingPath: conflict.memory.path,
      };
    }
    const memoryKey = this.memoryKey({
      workspaceId: input.workspaceId,
      memoryStoreId: input.memory.memoryStoreId,
      memoryId: input.memory.id,
    });
    const versionKey = this.versionKey({
      workspaceId: input.workspaceId,
      memoryStoreId: input.version.memoryStoreId,
      memoryVersionId: input.version.id,
    });
    if (this.memories.has(memoryKey) || this.versions.has(versionKey)) {
      throw new Error(`Memory ${input.memory.id} already exists`);
    }
    const memory = { memory: clone(input.memory), revision: 1 };
    const version = { version: clone(input.version), revision: 1 };
    this.memories.set(memoryKey, memory);
    this.versions.set(versionKey, version);
    return { type: "created", memory: clone(memory), version: clone(version) };
  }

  async findCurrent(input: MemoryLocation): Promise<StoredMemory | null> {
    const record = this.memories.get(this.memoryKey(input));
    return record === undefined ? null : clone(record);
  }

  async replace(input: ReplaceMemoryRecord): Promise<ReplaceMemoryRecordResult> {
    if (input.next.id !== input.memoryId) {
      throw new Error("Replacement Memory ID does not match the target");
    }
    if (input.next.memoryStoreId !== input.memoryStoreId) {
      throw new Error("Replacement Memory Store does not match the target");
    }
    validateMutationPair(input.next, input.version);
    const memoryKey = this.memoryKey(input);
    const current = this.memories.get(memoryKey);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict",
        actualRevision: current.revision,
      };
    }
    const conflict = this.findPath({
      workspaceId: input.workspaceId,
      memoryStoreId: input.memoryStoreId,
      path: input.next.path,
      excludingMemoryId: input.memoryId,
    });
    if (conflict !== null) {
      return {
        type: "path_conflict",
        conflictingMemoryId: conflict.memory.id,
        conflictingPath: conflict.memory.path,
      };
    }
    const versionKey = this.versionKey({
      workspaceId: input.workspaceId,
      memoryStoreId: input.memoryStoreId,
      memoryVersionId: input.version.id,
    });
    if (this.versions.has(versionKey)) {
      throw new Error(`Memory Version ${input.version.id} already exists`);
    }
    const memory = {
      memory: clone(input.next),
      revision: current.revision + 1,
    };
    const version = { version: clone(input.version), revision: 1 };
    this.memories.set(memoryKey, memory);
    this.versions.set(versionKey, version);
    return { type: "replaced", memory: clone(memory), version: clone(version) };
  }

  async delete(input: DeleteMemoryRecord): Promise<DeleteMemoryRecordResult> {
    if (
      input.version.memoryId !== input.memoryId
      || input.version.memoryStoreId !== input.memoryStoreId
      || input.version.operation !== "deleted"
    ) {
      throw new Error("Deleted Memory Version does not match the target");
    }
    const memoryKey = this.memoryKey(input);
    const current = this.memories.get(memoryKey);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict",
        actualRevision: current.revision,
      };
    }
    const versionKey = this.versionKey({
      workspaceId: input.workspaceId,
      memoryStoreId: input.memoryStoreId,
      memoryVersionId: input.version.id,
    });
    if (this.versions.has(versionKey)) {
      throw new Error(`Memory Version ${input.version.id} already exists`);
    }
    const version = { version: clone(input.version), revision: 1 };
    this.memories.delete(memoryKey);
    this.versions.set(versionKey, version);
    return { type: "deleted", version: clone(version) };
  }

  async listCurrent(input: ListMemoryRecords): Promise<StoredMemoryListPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Memory list limit must be a positive integer");
    }
    const prefix = `${input.workspaceId}\u0000${input.memoryStoreId}\u0000`;
    const byPath = new Map<string, StoredMemoryListItem>();
    for (const [key, stored] of this.memories) {
      if (!key.startsWith(prefix) || !stored.memory.path.startsWith(input.pathPrefix)) {
        continue;
      }
      const relative = stored.memory.path.slice(input.pathPrefix.length);
      const segments = relative.split("/");
      if (input.depth > 0 && segments.length > input.depth) {
        const path = `${input.pathPrefix}${segments.slice(0, input.depth).join("/")}/`;
        byPath.set(path, { kind: "prefix", path });
      } else {
        byPath.set(stored.memory.path, {
          kind: "memory",
          record: clone(stored),
        });
      }
    }
    const sorted = [...byPath.values()].sort((left, right) => {
      const leftPath = left.kind === "prefix" ? left.path : left.record.memory.path;
      const rightPath = right.kind === "prefix" ? right.path : right.record.memory.path;
      return leftPath.localeCompare(rightPath) || left.kind.localeCompare(right.kind);
    });
    const positioned = input.position === undefined
      ? sorted
      : sorted.filter((item) => {
          const path = item.kind === "prefix" ? item.path : item.record.memory.path;
          return path > input.position!.path
            || (path === input.position!.path && item.kind > input.position!.kind);
        });
    return {
      items: positioned.slice(0, input.limit).map(clone),
      hasMore: positioned.length > input.limit,
    };
  }

  async findVersion(
    input: MemoryVersionLocation,
  ): Promise<StoredMemoryVersion | null> {
    const record = this.versions.get(this.versionKey(input));
    return record === undefined ? null : clone(record);
  }

  async listVersions(
    input: ListMemoryVersionRecords,
  ): Promise<StoredMemoryVersion[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Memory Version list limit must be a positive integer");
    }
    const prefix = `${input.workspaceId}\u0000${input.memoryStoreId}\u0000`;
    return [...this.versions.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
      .filter((record) => actorMatches(record.version.createdBy, input))
      .filter((record) => input.memoryId === undefined
        || record.version.memoryId === input.memoryId)
      .filter((record) => input.operation === undefined
        || record.version.operation === input.operation)
      .filter((record) => input.createdAtOrAfter === undefined
        || record.version.createdAt >= input.createdAtOrAfter)
      .filter((record) => input.createdAtOrBefore === undefined
        || record.version.createdAt <= input.createdAtOrBefore)
      .filter((record) => input.position === undefined
        || record.version.createdAt < input.position.createdAt
        || (record.version.createdAt === input.position.createdAt
          && record.version.id < input.position.memoryVersionId))
      .sort((left, right) =>
        right.version.createdAt.localeCompare(left.version.createdAt)
        || right.version.id.localeCompare(left.version.id))
      .slice(0, input.limit)
      .map(clone);
  }

  async redactVersion(
    input: RedactMemoryVersionRecord,
  ): Promise<RedactMemoryVersionRecordResult> {
    const key = this.versionKey(input);
    const current = this.versions.get(key);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict",
        actualRevision: current.revision,
      };
    }
    const version: MemoryVersion = {
      ...clone(current.version),
      content: null,
      contentSha256: null,
      contentSizeBytes: null,
      path: null,
      redactedAt: input.redactedAt,
      redactedBy: clone(input.redactedBy),
    };
    const record = { version, revision: current.revision + 1 };
    this.versions.set(key, record);
    return { type: "redacted", record: clone(record) };
  }
}
