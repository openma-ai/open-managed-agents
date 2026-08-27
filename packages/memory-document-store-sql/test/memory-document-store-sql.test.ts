import { beforeEach, describe, expect, it } from "vitest";
import type {
  Memory,
  MemoryVersion,
} from "@open-managed-agents/domain/memories";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlMemoryDocumentStore } from "../src/index";

const SCHEMA = `
CREATE TABLE managed_memories (
  workspace_id text NOT NULL,
  memory_store_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  path text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE UNIQUE INDEX idx_managed_memories_workspace_store_path
  ON managed_memories (workspace_id, memory_store_id, path);
CREATE TABLE managed_memory_versions (
  workspace_id text NOT NULL,
  memory_store_id text NOT NULL,
  id text NOT NULL,
  memory_id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  operation text NOT NULL,
  actor_kind text NOT NULL,
  actor_id text NOT NULL,
  created_at integer NOT NULL,
  redacted_at integer,
  PRIMARY KEY (workspace_id, id)
);
`;

function memory(
  id: string,
  versionId: string,
  path: string,
  createdAt = "2026-08-26T18:00:00.000Z",
): Memory {
  return {
    id,
    content: "hello",
    contentSha256: "a".repeat(64),
    contentSizeBytes: 5,
    createdAt,
    memoryStoreId: "memstore_01",
    memoryVersionId: versionId,
    path,
    updatedAt: createdAt,
  };
}

function version(
  value: Memory,
  operation: MemoryVersion["operation"] = "created",
): MemoryVersion {
  return {
    id: value.memoryVersionId,
    content: value.content,
    contentSha256: value.contentSha256,
    contentSizeBytes: value.contentSizeBytes,
    createdAt: value.updatedAt,
    createdBy: { kind: "api", apiKeyId: "apikey_01" },
    memoryId: value.id,
    memoryStoreId: value.memoryStoreId,
    operation,
    path: value.path,
    redactedAt: null,
  };
}

describe("SqlMemoryDocumentStore", () => {
  let client: SqlClient;
  let store: SqlMemoryDocumentStore;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA);
    store = new SqlMemoryDocumentStore(client);
  });

  it("atomically creates current state and history with scoped path uniqueness", async () => {
    const first = memory("mem_01", "memver_01", "/notes/one.md");
    await expect(store.create({
      workspaceId: "workspace_01",
      memory: first,
      version: version(first),
    })).resolves.toEqual({
      type: "created",
      memory: { memory: first, revision: 1 },
      version: { version: version(first), revision: 1 },
    });
    await expect(store.findCurrent({
      workspaceId: "workspace_other",
      memoryStoreId: "memstore_01",
      memoryId: first.id,
    })).resolves.toBeNull();

    const duplicate = memory("mem_02", "memver_02", first.path);
    await expect(store.create({
      workspaceId: "workspace_01",
      memory: duplicate,
      version: version(duplicate),
    })).resolves.toEqual({
      type: "path_conflict",
      conflictingMemoryId: first.id,
      conflictingPath: first.path,
    });
    await expect(store.findVersion({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryVersionId: "memver_02",
    })).resolves.toBeNull();
  });

  it("preserves CAS, prefix paging, version filters, redaction, and terminal history", async () => {
    const first = memory("mem_01", "memver_01", "/notes/a.md");
    const second = memory(
      "mem_02",
      "memver_02",
      "/notes/deeper/b.md",
      "2026-08-26T19:00:00.000Z",
    );
    await store.create({
      workspaceId: "workspace_01",
      memory: first,
      version: version(first),
    });
    await store.create({
      workspaceId: "workspace_01",
      memory: second,
      version: version(second),
    });
    await expect(store.listCurrent({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      limit: 10,
      depth: 1,
      pathPrefix: "/notes/",
    })).resolves.toEqual({
      items: [
        { kind: "memory", record: { memory: first, revision: 1 } },
        { kind: "prefix", path: "/notes/deeper/" },
      ],
      hasMore: false,
    });

    const next = {
      ...first,
      content: "updated",
      contentSha256: "b".repeat(64),
      contentSizeBytes: 7,
      memoryVersionId: "memver_03",
      updatedAt: "2026-08-26T20:00:00.000Z",
    } satisfies Memory;
    await expect(store.replace({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryId: first.id,
      expectedRevision: 1,
      next,
      version: version(next, "modified"),
    })).resolves.toMatchObject({ type: "replaced", memory: { revision: 2 } });
    await expect(store.replace({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryId: first.id,
      expectedRevision: 1,
      next: { ...next, memoryVersionId: "memver_orphan" },
      version: version(
        { ...next, memoryVersionId: "memver_orphan" },
        "modified",
      ),
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.listVersions({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      limit: 10,
      apiKeyId: "apikey_01",
      createdAtOrAfter: first.createdAt,
      createdAtOrBefore: next.updatedAt,
    })).resolves.toHaveLength(3);
    await expect(store.redactVersion({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryVersionId: "memver_01",
      expectedRevision: 1,
      redactedAt: "2026-08-26T21:00:00.000Z",
      redactedBy: { kind: "user", userId: "user_01" },
    })).resolves.toMatchObject({
      type: "redacted",
      record: { revision: 2, version: { content: null, path: null } },
    });

    const terminalMemory = {
      ...next,
      memoryVersionId: "memver_04",
      updatedAt: "2026-08-26T22:00:00.000Z",
    };
    const terminal = version(terminalMemory, "deleted");
    await expect(store.delete({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryId: first.id,
      expectedRevision: 2,
      version: terminal,
    })).resolves.toEqual({
      type: "deleted",
      version: { version: terminal, revision: 1 },
    });
    await expect(store.findCurrent({
      workspaceId: "workspace_01",
      memoryStoreId: "memstore_01",
      memoryId: first.id,
    })).resolves.toBeNull();
  });
});
