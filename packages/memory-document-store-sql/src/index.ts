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
import type { SqlClient } from "@open-managed-agents/sql-client";

interface MemoryRow {
  id: string;
  document: string;
  revision: number;
  path: string;
  created_at: number;
  updated_at: number;
}

interface MemoryVersionRow {
  id: string;
  document: string;
  revision: number;
  created_at: number;
  redacted_at: number | null;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid Memory timestamp: ${value}`);
  }
  return milliseconds;
}

function actorColumns(actor: MemoryVersionActor): {
  kind: string;
  id: string;
} {
  switch (actor.kind) {
    case "api":
      return { kind: actor.kind, id: actor.apiKeyId };
    case "service_account":
      return { kind: actor.kind, id: actor.serviceAccountId };
    case "session":
      return { kind: actor.kind, id: actor.sessionId };
    case "user":
      return { kind: actor.kind, id: actor.userId };
  }
}

function toStoredMemory(row: MemoryRow): StoredMemory {
  const stored = JSON.parse(row.document) as Memory;
  return {
    revision: Number(row.revision),
    memory: {
      ...stored,
      id: row.id,
      path: row.path,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(),
    },
  };
}

function toStoredMemoryVersion(row: MemoryVersionRow): StoredMemoryVersion {
  const stored = JSON.parse(row.document) as MemoryVersion;
  return {
    revision: Number(row.revision),
    version: {
      ...stored,
      id: row.id,
      createdAt: new Date(Number(row.created_at)).toISOString(),
      redactedAt: row.redacted_at === null
        ? null
        : new Date(Number(row.redacted_at)).toISOString(),
    },
  };
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

export class SqlMemoryDocumentStore implements MemoryDocumentStore {
  constructor(private readonly client: SqlClient) {}

  private async findByPath(input: {
    workspaceId: string;
    memoryStoreId: string;
    path: string;
  }): Promise<StoredMemory | null> {
    const row = await this.client.prepare(
      `SELECT id, document, revision, path, created_at, updated_at
         FROM managed_memories
        WHERE workspace_id = ? AND memory_store_id = ? AND path = ?`,
    ).bind(
      input.workspaceId,
      input.memoryStoreId,
      input.path,
    ).first<MemoryRow>();
    return row === null ? null : toStoredMemory(row);
  }

  async create(input: CreateMemoryRecord): Promise<CreateMemoryRecordResult> {
    validateMutationPair(input.memory, input.version);
    const actor = actorColumns(input.version.createdBy);
    const current = this.client.prepare(
      `INSERT INTO managed_memories
        (workspace_id, memory_store_id, id, document, revision,
         path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.workspaceId,
      input.memory.memoryStoreId,
      input.memory.id,
      JSON.stringify(input.memory),
      1,
      input.memory.path,
      timestamp(input.memory.createdAt),
      timestamp(input.memory.updatedAt),
    );
    const history = this.client.prepare(
      `INSERT INTO managed_memory_versions
        (workspace_id, memory_store_id, id, memory_id, document, revision,
         operation, actor_kind, actor_id, created_at, redacted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.workspaceId,
      input.version.memoryStoreId,
      input.version.id,
      input.version.memoryId,
      JSON.stringify(input.version),
      1,
      input.version.operation,
      actor.kind,
      actor.id,
      timestamp(input.version.createdAt),
      input.version.redactedAt === null
        ? null
        : timestamp(input.version.redactedAt),
    );
    try {
      const results = await this.client.batch([current, history]);
      if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
        throw new Error(
          `Memory creation violated atomic write invariants: current=${results[0]?.meta.changes ?? "missing"}, version=${results[1]?.meta.changes ?? "missing"}`,
        );
      }
    } catch (error) {
      const conflict = await this.findByPath({
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
      throw error;
    }
    const memory = await this.findCurrent({
      workspaceId: input.workspaceId,
      memoryStoreId: input.memory.memoryStoreId,
      memoryId: input.memory.id,
    });
    const version = await this.findVersion({
      workspaceId: input.workspaceId,
      memoryStoreId: input.version.memoryStoreId,
      memoryVersionId: input.version.id,
    });
    if (memory === null || version === null) {
      throw new Error("Memory creation vanished after atomic write");
    }
    return { type: "created", memory, version };
  }

  async findCurrent(input: MemoryLocation): Promise<StoredMemory | null> {
    const row = await this.client.prepare(
      `SELECT id, document, revision, path, created_at, updated_at
         FROM managed_memories
        WHERE workspace_id = ? AND memory_store_id = ? AND id = ?`,
    ).bind(
      input.workspaceId,
      input.memoryStoreId,
      input.memoryId,
    ).first<MemoryRow>();
    return row === null ? null : toStoredMemory(row);
  }

  async replace(input: ReplaceMemoryRecord): Promise<ReplaceMemoryRecordResult> {
    if (input.next.id !== input.memoryId) {
      throw new Error("Replacement Memory ID does not match the target");
    }
    if (input.next.memoryStoreId !== input.memoryStoreId) {
      throw new Error("Replacement Memory Store does not match the target");
    }
    validateMutationPair(input.next, input.version);
    const actor = actorColumns(input.version.createdBy);
    const history = this.client.prepare(
      `INSERT INTO managed_memory_versions
        (workspace_id, memory_store_id, id, memory_id, document, revision,
         operation, actor_kind, actor_id, created_at, redacted_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM managed_memories
        WHERE workspace_id = ? AND memory_store_id = ? AND id = ? AND revision = ?`,
    ).bind(
      input.workspaceId,
      input.version.memoryStoreId,
      input.version.id,
      input.version.memoryId,
      JSON.stringify(input.version),
      1,
      input.version.operation,
      actor.kind,
      actor.id,
      timestamp(input.version.createdAt),
      input.version.redactedAt === null
        ? null
        : timestamp(input.version.redactedAt),
      input.workspaceId,
      input.memoryStoreId,
      input.memoryId,
      input.expectedRevision,
    );
    const current = this.client.prepare(
      `UPDATE managed_memories
          SET document = ?, revision = revision + 1,
              path = ?, updated_at = ?
        WHERE workspace_id = ? AND memory_store_id = ? AND id = ? AND revision = ?`,
    ).bind(
      JSON.stringify(input.next),
      input.next.path,
      timestamp(input.next.updatedAt),
      input.workspaceId,
      input.memoryStoreId,
      input.memoryId,
      input.expectedRevision,
    );
    let results;
    try {
      results = await this.client.batch([history, current]);
    } catch (error) {
      const conflict = await this.findByPath({
        workspaceId: input.workspaceId,
        memoryStoreId: input.memoryStoreId,
        path: input.next.path,
      });
      if (conflict !== null && conflict.memory.id !== input.memoryId) {
        return {
          type: "path_conflict",
          conflictingMemoryId: conflict.memory.id,
          conflictingPath: conflict.memory.path,
        };
      }
      throw error;
    }
    const historyChanges = results[0]?.meta.changes;
    const currentChanges = results[1]?.meta.changes;
    if (historyChanges === 0 && currentChanges === 0) {
      const found = await this.findCurrent(input);
      return found === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: found.revision };
    }
    if (historyChanges !== 1 || currentChanges !== 1) {
      throw new Error(
        `Memory replacement violated atomic write invariants: version=${historyChanges ?? "missing"}, current=${currentChanges ?? "missing"}`,
      );
    }
    const memory = await this.findCurrent(input);
    const version = await this.findVersion({
      workspaceId: input.workspaceId,
      memoryStoreId: input.memoryStoreId,
      memoryVersionId: input.version.id,
    });
    if (memory === null || version === null) {
      throw new Error("Memory replacement vanished after atomic write");
    }
    return { type: "replaced", memory, version };
  }

  async delete(input: DeleteMemoryRecord): Promise<DeleteMemoryRecordResult> {
    if (
      input.version.memoryId !== input.memoryId
      || input.version.memoryStoreId !== input.memoryStoreId
      || input.version.operation !== "deleted"
    ) {
      throw new Error("Deleted Memory Version does not match the target");
    }
    const actor = actorColumns(input.version.createdBy);
    const history = this.client.prepare(
      `INSERT INTO managed_memory_versions
        (workspace_id, memory_store_id, id, memory_id, document, revision,
         operation, actor_kind, actor_id, created_at, redacted_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM managed_memories
        WHERE workspace_id = ? AND memory_store_id = ? AND id = ? AND revision = ?`,
    ).bind(
      input.workspaceId,
      input.version.memoryStoreId,
      input.version.id,
      input.version.memoryId,
      JSON.stringify(input.version),
      1,
      input.version.operation,
      actor.kind,
      actor.id,
      timestamp(input.version.createdAt),
      input.version.redactedAt === null
        ? null
        : timestamp(input.version.redactedAt),
      input.workspaceId,
      input.memoryStoreId,
      input.memoryId,
      input.expectedRevision,
    );
    const current = this.client.prepare(
      `DELETE FROM managed_memories
        WHERE workspace_id = ? AND memory_store_id = ? AND id = ? AND revision = ?`,
    ).bind(
      input.workspaceId,
      input.memoryStoreId,
      input.memoryId,
      input.expectedRevision,
    );
    const results = await this.client.batch([history, current]);
    const historyChanges = results[0]?.meta.changes;
    const currentChanges = results[1]?.meta.changes;
    if (historyChanges === 0 && currentChanges === 0) {
      const found = await this.findCurrent(input);
      return found === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: found.revision };
    }
    if (historyChanges !== 1 || currentChanges !== 1) {
      throw new Error(
        `Memory deletion violated atomic write invariants: version=${historyChanges ?? "missing"}, current=${currentChanges ?? "missing"}`,
      );
    }
    const version = await this.findVersion({
      workspaceId: input.workspaceId,
      memoryStoreId: input.memoryStoreId,
      memoryVersionId: input.version.id,
    });
    if (version === null) throw new Error("Deleted Memory Version vanished");
    return { type: "deleted", version };
  }

  async listCurrent(input: ListMemoryRecords): Promise<StoredMemoryListPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Memory list limit must be a positive integer");
    }
    const rows = await this.client.prepare(
      `SELECT id, document, revision, path, created_at, updated_at
         FROM managed_memories
        WHERE workspace_id = ? AND memory_store_id = ?
        ORDER BY path ASC, id ASC`,
    ).bind(input.workspaceId, input.memoryStoreId).all<MemoryRow>();
    const byPath = new Map<string, StoredMemoryListItem>();
    for (const row of rows.results ?? []) {
      if (!row.path.startsWith(input.pathPrefix)) continue;
      const record = toStoredMemory(row);
      const relative = row.path.slice(input.pathPrefix.length);
      const segments = relative.split("/");
      if (input.depth > 0 && segments.length > input.depth) {
        const path = `${input.pathPrefix}${segments.slice(0, input.depth).join("/")}/`;
        byPath.set(path, { kind: "prefix", path });
      } else {
        byPath.set(row.path, { kind: "memory", record });
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
      items: positioned.slice(0, input.limit),
      hasMore: positioned.length > input.limit,
    };
  }

  async findVersion(
    input: MemoryVersionLocation,
  ): Promise<StoredMemoryVersion | null> {
    const row = await this.client.prepare(
      `SELECT id, document, revision, created_at, redacted_at
         FROM managed_memory_versions
        WHERE workspace_id = ? AND memory_store_id = ? AND id = ?`,
    ).bind(
      input.workspaceId,
      input.memoryStoreId,
      input.memoryVersionId,
    ).first<MemoryVersionRow>();
    return row === null ? null : toStoredMemoryVersion(row);
  }

  async listVersions(
    input: ListMemoryVersionRecords,
  ): Promise<StoredMemoryVersion[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Memory Version list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?", "memory_store_id = ?"];
    const parameters: Array<string | number> = [
      input.workspaceId,
      input.memoryStoreId,
    ];
    if (input.apiKeyId !== undefined) {
      conditions.push("actor_kind = ? AND actor_id = ?");
      parameters.push("api", input.apiKeyId);
    }
    if (input.serviceAccountId !== undefined) {
      conditions.push("actor_kind = ? AND actor_id = ?");
      parameters.push("service_account", input.serviceAccountId);
    }
    if (input.sessionId !== undefined) {
      conditions.push("actor_kind = ? AND actor_id = ?");
      parameters.push("session", input.sessionId);
    }
    if (input.memoryId !== undefined) {
      conditions.push("memory_id = ?");
      parameters.push(input.memoryId);
    }
    if (input.operation !== undefined) {
      conditions.push("operation = ?");
      parameters.push(input.operation);
    }
    if (input.createdAtOrAfter !== undefined) {
      conditions.push("created_at >= ?");
      parameters.push(timestamp(input.createdAtOrAfter));
    }
    if (input.createdAtOrBefore !== undefined) {
      conditions.push("created_at <= ?");
      parameters.push(timestamp(input.createdAtOrBefore));
    }
    if (input.position !== undefined) {
      const createdAt = timestamp(input.position.createdAt);
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(createdAt, createdAt, input.position.memoryVersionId);
    }
    parameters.push(input.limit);
    const rows = await this.client.prepare(
      `SELECT id, document, revision, created_at, redacted_at
         FROM managed_memory_versions
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(...parameters).all<MemoryVersionRow>();
    return (rows.results ?? []).map(toStoredMemoryVersion);
  }

  async redactVersion(
    input: RedactMemoryVersionRecord,
  ): Promise<RedactMemoryVersionRecordResult> {
    const current = await this.findVersion(input);
    if (current === null) return { type: "not_found" };
    const next: MemoryVersion = {
      ...current.version,
      content: null,
      contentSha256: null,
      contentSizeBytes: null,
      path: null,
      redactedAt: input.redactedAt,
      redactedBy: input.redactedBy,
    };
    const result = await this.client.prepare(
      `UPDATE managed_memory_versions
          SET document = ?, revision = revision + 1, redacted_at = ?
        WHERE workspace_id = ? AND memory_store_id = ? AND id = ? AND revision = ?`,
    ).bind(
      JSON.stringify(next),
      timestamp(input.redactedAt),
      input.workspaceId,
      input.memoryStoreId,
      input.memoryVersionId,
      input.expectedRevision,
    ).run();
    if (result.meta.changes === 0) {
      const found = await this.findVersion(input);
      return found === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: found.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(
        `Memory Version redaction affected ${result.meta.changes} rows`,
      );
    }
    const record = await this.findVersion(input);
    if (record === null) throw new Error("Memory Version vanished after redaction");
    return { type: "redacted", record };
  }
}
