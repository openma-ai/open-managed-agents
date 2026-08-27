import { describe, expect, it } from "vitest";
import type {
  Memory,
  MemoryVersion,
} from "@open-managed-agents/domain/memories";
import type { MemoryDocumentStore } from "@open-managed-agents/memory-document-store";
import {
  MemoriesApplicationService,
  MemoryVersionsApplicationService,
} from "../src/index";

interface StoredMemory {
  memory: Memory;
  revision: number;
}

interface StoredMemoryVersion {
  version: MemoryVersion;
  revision: number;
}

class InMemoryMemoryPersistence implements MemoryDocumentStore {
  readonly memories = new Map<string, StoredMemory>();
  readonly versions = new Map<string, StoredMemoryVersion>();
  forceConflict = false;

  async create(input: {
    workspaceId: string;
    memory: Memory;
    version: MemoryVersion;
  }) {
    const pathConflict = Array.from(this.memories.values()).find(
      (record) =>
        record.memory.memoryStoreId === input.memory.memoryStoreId &&
        record.memory.path === input.memory.path,
    );
    if (pathConflict !== undefined) {
      return {
        type: "path_conflict" as const,
        conflictingMemoryId: pathConflict.memory.id,
        conflictingPath: pathConflict.memory.path,
      };
    }
    const memory = { memory: structuredClone(input.memory), revision: 1 };
    const version = { version: structuredClone(input.version), revision: 1 };
    this.memories.set(`${input.workspaceId}:${input.memory.id}`, memory);
    this.versions.set(`${input.workspaceId}:${input.version.id}`, version);
    return {
      type: "created" as const,
      memory: structuredClone(memory),
      version: structuredClone(version),
    };
  }

  async findCurrent(input: {
    workspaceId: string;
    memoryStoreId: string;
    memoryId: string;
  }) {
    const record = this.memories.get(`${input.workspaceId}:${input.memoryId}`);
    return record === undefined || record.memory.memoryStoreId !== input.memoryStoreId
      ? null
      : structuredClone(record);
  }

  async replace(input: {
    workspaceId: string;
    memoryStoreId: string;
    memoryId: string;
    expectedRevision: number;
    next: Memory;
    version: MemoryVersion;
  }) {
    const key = `${input.workspaceId}:${input.memoryId}`;
    const current = this.memories.get(key);
    if (current === undefined || current.memory.memoryStoreId !== input.memoryStoreId) {
      return { type: "not_found" as const };
    }
    const pathConflict = Array.from(this.memories.values()).find(
      (record) =>
        record.memory.id !== input.memoryId &&
        record.memory.memoryStoreId === input.memoryStoreId &&
        record.memory.path === input.next.path,
    );
    if (pathConflict !== undefined) {
      return {
        type: "path_conflict" as const,
        conflictingMemoryId: pathConflict.memory.id,
        conflictingPath: pathConflict.memory.path,
      };
    }
    if (this.forceConflict || current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict" as const,
        actualRevision: current.revision,
      };
    }
    const memory = {
      memory: structuredClone(input.next),
      revision: current.revision + 1,
    };
    const version = { version: structuredClone(input.version), revision: 1 };
    this.memories.set(key, memory);
    this.versions.set(`${input.workspaceId}:${input.version.id}`, version);
    return {
      type: "replaced" as const,
      memory: structuredClone(memory),
      version: structuredClone(version),
    };
  }

  async delete(input: {
    workspaceId: string;
    memoryStoreId: string;
    memoryId: string;
    expectedRevision: number;
    version: MemoryVersion;
  }) {
    const key = `${input.workspaceId}:${input.memoryId}`;
    const current = this.memories.get(key);
    if (current === undefined || current.memory.memoryStoreId !== input.memoryStoreId) {
      return { type: "not_found" as const };
    }
    if (this.forceConflict || current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict" as const,
        actualRevision: current.revision,
      };
    }
    this.memories.delete(key);
    const version = { version: structuredClone(input.version), revision: 1 };
    this.versions.set(`${input.workspaceId}:${input.version.id}`, version);
    return { type: "deleted" as const, version: structuredClone(version) };
  }

  async listCurrent() {
    return { items: [], hasMore: false };
  }

  async findVersion(input: {
    workspaceId: string;
    memoryStoreId: string;
    memoryVersionId: string;
  }) {
    const record = this.versions.get(
      `${input.workspaceId}:${input.memoryVersionId}`,
    );
    return record === undefined ||
      record.version.memoryStoreId !== input.memoryStoreId
      ? null
      : structuredClone(record);
  }

  async listVersions() {
    return [];
  }

  async redactVersion(input: {
    workspaceId: string;
    memoryStoreId: string;
    memoryVersionId: string;
    expectedRevision: number;
    redactedAt: string;
    redactedBy: MemoryVersion["createdBy"];
  }) {
    const key = `${input.workspaceId}:${input.memoryVersionId}`;
    const current = this.versions.get(key);
    if (current === undefined || current.version.memoryStoreId !== input.memoryStoreId) {
      return { type: "not_found" as const };
    }
    if (current.revision !== input.expectedRevision) {
      return {
        type: "revision_conflict" as const,
        actualRevision: current.revision,
      };
    }
    const version: MemoryVersion = {
      ...current.version,
      content: null,
      contentSha256: null,
      contentSizeBytes: null,
      path: null,
      redactedAt: input.redactedAt,
      ...(input.redactedBy !== undefined && {
        redactedBy: input.redactedBy,
      }),
    };
    const record = { version, revision: current.revision + 1 };
    this.versions.set(key, structuredClone(record));
    return { type: "redacted" as const, record: structuredClone(record) };
  }
}

function buildServices(persistence: InMemoryMemoryPersistence) {
  let memorySequence = 0;
  let versionSequence = 0;
  let now = new Date("2026-08-26T19:00:00.000Z");
  const actor = { kind: "api" as const, apiKeyId: "apikey_self_hosted" };
  const memories = new MemoriesApplicationService({
    workspaceId: "workspace_01",
    store: persistence,
    memoryStores: {
      find: async (input: { workspaceId: string; memoryStoreId: string }) =>
        input.workspaceId === "workspace_01" &&
        input.memoryStoreId === "memstore_01"
          ? {
              id: input.memoryStoreId,
              archivedAt: null,
              createdAt: "2026-08-26T18:00:00.000Z",
              name: "Project memory",
              updatedAt: "2026-08-26T18:00:00.000Z",
            }
          : null,
    },
    content: {
      describe: async (input: { content: string | null }) => ({
        sha256:
          input.content === "updated" ? "b".repeat(64) : "a".repeat(64),
        sizeBytes: new TextEncoder().encode(input.content ?? "").byteLength,
      }),
    },
    actor,
    clock: { now: () => now },
    ids: {
      nextMemoryId: () => `mem_0${++memorySequence}`,
      nextMemoryVersionId: () => `memver_0${++versionSequence}`,
    },
  });
  const versions = new MemoryVersionsApplicationService({
    workspaceId: "workspace_01",
    store: persistence,
    actor,
    clock: { now: () => now },
  });
  return {
    memories,
    versions,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

describe("MemoriesApplicationService", () => {
  it("atomically creates the current memory and its first immutable version", async () => {
    const persistence = new InMemoryMemoryPersistence();
    const { memories } = buildServices(persistence);

    const created = await memories.createMemory({
      memoryStoreId: "memstore_01",
      content: "hello",
      path: "/notes/one.md",
      projection: "full",
    });

    expect(created).toEqual({
      type: "created",
      memory: {
        kind: "memory",
        id: "mem_01",
        content: "hello",
        contentSha256: "a".repeat(64),
        contentSizeBytes: 5,
        createdAt: "2026-08-26T19:00:00.000Z",
        memoryStoreId: "memstore_01",
        memoryVersionId: "memver_01",
        path: "/notes/one.md",
        updatedAt: "2026-08-26T19:00:00.000Z",
      },
    });
    expect(persistence.versions.get("workspace_01:memver_01")?.version).toEqual({
      id: "memver_01",
      content: "hello",
      contentSha256: "a".repeat(64),
      contentSizeBytes: 5,
      createdAt: "2026-08-26T19:00:00.000Z",
      createdBy: { kind: "api", apiKeyId: "apikey_self_hosted" },
      memoryId: "mem_01",
      memoryStoreId: "memstore_01",
      operation: "created",
      path: "/notes/one.md",
      redactedAt: null,
    });
  });

  it("enforces content preconditions while preserving idempotent retries", async () => {
    const persistence = new InMemoryMemoryPersistence();
    const services = buildServices(persistence);
    await services.memories.createMemory({
      memoryStoreId: "memstore_01",
      content: "hello",
      path: "/notes/one.md",
    });

    await expect(
      services.memories.updateMemory({
        memoryStoreId: "memstore_01",
        memoryId: "mem_01",
        content: "updated",
        contentPrecondition: { expectedSha256: "f".repeat(64) },
      }),
    ).resolves.toEqual({
      type: "precondition_failed",
      message: "Memory content SHA-256 precondition failed",
    });

    services.setNow("2026-08-26T20:00:00.000Z");
    await expect(
      services.memories.updateMemory({
        memoryStoreId: "memstore_01",
        memoryId: "mem_01",
        content: "updated",
        path: "/notes/two.md",
        contentPrecondition: { expectedSha256: "a".repeat(64) },
        projection: "full",
      }),
    ).resolves.toMatchObject({
      type: "updated",
      memory: {
        content: "updated",
        contentSha256: "b".repeat(64),
        memoryVersionId: "memver_02",
        path: "/notes/two.md",
      },
    });

    await expect(
      services.memories.updateMemory({
        memoryStoreId: "memstore_01",
        memoryId: "mem_01",
        content: "updated",
        path: "/notes/two.md",
        contentPrecondition: { expectedSha256: "a".repeat(64) },
      }),
    ).resolves.toMatchObject({ type: "updated" });
    expect(persistence.versions.size).toBe(2);
  });

  it("rejects malformed paths and cursors before persistence", async () => {
    const persistence = new InMemoryMemoryPersistence();
    const { memories } = buildServices(persistence);

    await expect(
      memories.createMemory({
        memoryStoreId: "memstore_01",
        content: "hello",
        path: "/notes/../secret",
      }),
    ).resolves.toEqual({
      type: "invalid_request",
      message: "Memory path contains an invalid segment",
    });
    await expect(
      memories.listMemories({
        memoryStoreId: "memstore_01",
        cursor: "not-a-cursor",
      }),
    ).resolves.toEqual({
      type: "invalid_request",
      message: "Invalid memory page cursor",
    });
  });
});

describe("MemoryVersionsApplicationService", () => {
  it("returns projection-safe history and redacts it with CAS", async () => {
    const persistence = new InMemoryMemoryPersistence();
    const services = buildServices(persistence);
    await services.memories.createMemory({
      memoryStoreId: "memstore_01",
      content: "hello",
      path: "/notes/one.md",
    });

    await expect(
      services.versions.retrieveMemoryVersion({
        memoryStoreId: "memstore_01",
        memoryVersionId: "memver_01",
        projection: "basic",
      }),
    ).resolves.toMatchObject({
      type: "found",
      version: { id: "memver_01", content: null },
    });
    await expect(
      services.versions.redactMemoryVersion({
        memoryStoreId: "memstore_01",
        memoryVersionId: "memver_01",
      }),
    ).resolves.toMatchObject({
      type: "redacted",
      version: {
        content: null,
        contentSha256: null,
        contentSizeBytes: null,
        path: null,
        redactedAt: "2026-08-26T19:00:00.000Z",
      },
    });
  });
});
