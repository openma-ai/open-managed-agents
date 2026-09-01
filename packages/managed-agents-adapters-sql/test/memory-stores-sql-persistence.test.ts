import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { MemoryStore } from "@open-managed-agents/managed-agents-application";
import {
  SqlMemoryStorePersistence,
  SqlMemoryStoreSource,
} from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_memory_stores (
  workspace_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_managed_memory_stores_workspace_created_id
  ON managed_memory_stores (workspace_id, created_at, id);
`;

const store = (
  id: string,
  createdAt: string,
  name = "Project memory",
): MemoryStore => ({
  id,
  createdAt,
  name,
  updatedAt: createdAt,
  archivedAt: null,
  description: "Facts",
  metadata: { owner: "platform" },
});

describe("SqlMemoryStorePersistence", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("persists, replaces with CAS, and resolves a complete snapshot", async () => {
    const persistence = new SqlMemoryStorePersistence(client);
    const source = new SqlMemoryStoreSource(client);
    const initial = store("memstore_01", "2026-08-26T16:00:00.000Z");
    await expect(
      persistence.insert({ workspaceId: "workspace_01", memoryStore: initial }),
    ).resolves.toEqual({ memoryStore: initial, revision: 1 });
    await expect(
      source.find({
        workspaceId: "workspace_01",
        memoryStoreId: initial.id,
      }),
    ).resolves.toEqual(initial);
    await expect(
      source.find({
        workspaceId: "workspace_other",
        memoryStoreId: initial.id,
      }),
    ).resolves.toBeNull();

    const next = {
      ...initial,
      name: "Renamed",
      updatedAt: "2026-08-26T17:00:00.000Z",
    };
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        memoryStoreId: initial.id,
        expectedRevision: 1,
        next,
      }),
    ).resolves.toEqual({
      type: "replaced",
      record: { memoryStore: next, revision: 2 },
    });
    await expect(
      persistence.replace({
        workspaceId: "workspace_01",
        memoryStoreId: initial.id,
        expectedRevision: 1,
        next: initial,
      }),
    ).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("pages by tenant and time, then archives and deletes atomically", async () => {
    const persistence = new SqlMemoryStorePersistence(client);
    const first = store("memstore_01", "2026-08-26T16:00:00.000Z", "First");
    const second = store("memstore_02", "2026-08-26T17:00:00.000Z", "Second");
    await persistence.insert({ workspaceId: "workspace_01", memoryStore: first });
    await persistence.insert({ workspaceId: "workspace_01", memoryStore: second });
    await persistence.insert({ workspaceId: "workspace_other", memoryStore: first });

    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        limit: 10,
        includeArchived: false,
        createdAtOrAfter: first.createdAt,
        createdAtOrBefore: second.createdAt,
        position: { createdAt: first.createdAt, memoryStoreId: first.id },
      }),
    ).resolves.toEqual([{ memoryStore: second, revision: 1 }]);
    await expect(
      persistence.archive({
        workspaceId: "workspace_01",
        memoryStoreId: first.id,
        archivedAt: "2026-08-26T18:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      type: "archived",
      record: {
        revision: 2,
        memoryStore: {
          id: first.id,
          archivedAt: "2026-08-26T18:00:00.000Z",
          updatedAt: "2026-08-26T18:00:00.000Z",
        },
      },
    });
    await expect(
      persistence.delete({
        workspaceId: "workspace_01",
        memoryStoreId: first.id,
      }),
    ).resolves.toEqual({ type: "deleted" });
    await expect(
      persistence.find({
        workspaceId: "workspace_other",
        memoryStoreId: first.id,
      }),
    ).resolves.not.toBeNull();
  });
});
