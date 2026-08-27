import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  Memory,
  MemoryVersion,
} from "@open-managed-agents/managed-agents-application";
import { SqlMemoryPersistence } from "../src";

const SCHEMA_SQL = `
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
CREATE INDEX idx_managed_memories_workspace_store_updated_id
  ON managed_memories (workspace_id, memory_store_id, updated_at, id);
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
CREATE INDEX idx_managed_memory_versions_workspace_store_created_id
  ON managed_memory_versions (workspace_id, memory_store_id, created_at, id);
CREATE INDEX idx_managed_memory_versions_workspace_memory_created_id
  ON managed_memory_versions (workspace_id, memory_id, created_at, id);
`;

const memory = (
  id: string,
  versionId: string,
  path: string,
  createdAt = "2026-08-26T18:00:00.000Z",
): Memory => ({
  id,
  content: "hello",
  contentSha256: "a".repeat(64),
  contentSizeBytes: 5,
  createdAt,
  memoryStoreId: "memstore_01",
  memoryVersionId: versionId,
  path,
  updatedAt: createdAt,
});

const version = (
  value: Memory,
  id = value.memoryVersionId,
  operation: MemoryVersion["operation"] = "created",
): MemoryVersion => ({
  id,
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
});

describe("SqlMemoryPersistence", () => {
  let client: SqlClient;
  let persistence: SqlMemoryPersistence;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
    persistence = new SqlMemoryPersistence(client);
  });

  it("atomically creates current state and history with scoped path uniqueness", async () => {
    const first = memory("mem_01", "memver_01", "/notes/one.md");
    await expect(
      persistence.create({
        workspaceId: "workspace_01",
        memory: first,
        version: version(first),
      }),
    ).resolves.toEqual({
      type: "created",
      memory: { memory: first, revision: 1 },
      version: { version: version(first), revision: 1 },
    });
    await expect(
      persistence.findCurrent({
        workspaceId: "workspace_other",
        memoryStoreId: "memstore_01",
        memoryId: first.id,
      }),
    ).resolves.toBeNull();

    const duplicate = memory("mem_02", "memver_02", first.path);
    await expect(
      persistence.create({
        workspaceId: "workspace_01",
        memory: duplicate,
        version: version(duplicate),
      }),
    ).resolves.toEqual({
      type: "path_conflict",
      conflictingMemoryId: first.id,
      conflictingPath: first.path,
    });
    const orphan = await client
      .prepare(
        `SELECT COUNT(*) AS count
           FROM managed_memory_versions
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind("workspace_01", duplicate.memoryVersionId)
      .first<{ count: number }>();
    expect(Number(orphan?.count)).toBe(0);
  });

  it("replaces with atomic CAS and never leaves an orphan version on conflict", async () => {
    const initial = memory("mem_01", "memver_01", "/notes/one.md");
    await persistence.create({
      workspaceId: "workspace_01",
      memory: initial,
      version: version(initial),
    });
    const next: Memory = {
      ...initial,
      content: "updated",
      contentSha256: "b".repeat(64),
      contentSizeBytes: 7,
      memoryVersionId: "memver_02",
      path: "/notes/two.md",
      updatedAt: "2026-08-26T19:00:00.000Z",
    };
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        memoryStoreId: "memstore_01",
        memoryId: initial.id,
        expectedRevision: 1,
        next,
        version: version(next, "memver_02", "modified"),
      }),
    ).resolves.toEqual({
      type: "replaced",
      memory: { memory: next, revision: 2 },
      version: {
        version: version(next, "memver_02", "modified"),
        revision: 1,
      },
    });

    const stale = {
      ...next,
      memoryVersionId: "memver_orphan",
      updatedAt: "2026-08-26T20:00:00.000Z",
    };
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        memoryStoreId: "memstore_01",
        memoryId: initial.id,
        expectedRevision: 1,
        next: stale,
        version: version(stale, "memver_orphan", "modified"),
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(
      persistence.findVersion({
        workspaceId: "workspace_01",
        memoryStoreId: "memstore_01",
        memoryVersionId: "memver_orphan",
      }),
    ).resolves.toBeNull();
  });

  it("deletes current state and appends its terminal version atomically", async () => {
    const initial = memory("mem_01", "memver_01", "/notes/one.md");
    await persistence.create({
      workspaceId: "workspace_01",
      memory: initial,
      version: version(initial),
    });
    const deletedVersion = version(initial, "memver_02", "deleted");

    await expect(
      persistence.delete({
        workspaceId: "workspace_01",
        memoryStoreId: "memstore_01",
        memoryId: initial.id,
        expectedRevision: 1,
        version: deletedVersion,
      }),
    ).resolves.toEqual({
      type: "deleted",
      version: { version: deletedVersion, revision: 1 },
    });
    await expect(
      persistence.findCurrent({
        workspaceId: "workspace_01",
        memoryStoreId: "memstore_01",
        memoryId: initial.id,
      }),
    ).resolves.toBeNull();
    await expect(
      persistence.findVersion({
        workspaceId: "workspace_01",
        memoryStoreId: "memstore_01",
        memoryVersionId: deletedVersion.id,
      }),
    ).resolves.toEqual({ version: deletedVersion, revision: 1 });
  });

  it("rolls up path prefixes and redacts version content with CAS", async () => {
    const first = memory("mem_01", "memver_01", "/notes/one.md");
    const second = memory("mem_02", "memver_02", "/notes/deeper/two.md");
    await persistence.create({
      workspaceId: "workspace_01",
      memory: first,
      version: version(first),
    });
    await persistence.create({
      workspaceId: "workspace_01",
      memory: second,
      version: version(second),
    });

    await expect(
      persistence.listCurrent({
        workspaceId: "workspace_01",
        memoryStoreId: "memstore_01",
        limit: 10,
        depth: 1,
        pathPrefix: "/notes/",
      }),
    ).resolves.toEqual({
      items: [
        { kind: "prefix", path: "/notes/deeper/" },
        { kind: "memory", record: { memory: first, revision: 1 } },
      ],
      hasMore: false,
    });

    await expect(
      persistence.redactVersion({
        workspaceId: "workspace_01",
        memoryStoreId: "memstore_01",
        memoryVersionId: "memver_01",
        expectedRevision: 1,
        redactedAt: "2026-08-26T20:00:00.000Z",
        redactedBy: { kind: "user", userId: "user_01" },
      }),
    ).resolves.toMatchObject({
      type: "redacted",
      record: {
        revision: 2,
        version: {
          content: null,
          contentSha256: null,
          contentSizeBytes: null,
          path: null,
          redactedAt: "2026-08-26T20:00:00.000Z",
          redactedBy: { kind: "user", userId: "user_01" },
        },
      },
    });
  });
});
