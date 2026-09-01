import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryStore } from "@open-managed-agents/domain/memory-stores";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { SqlMemoryStoreStore } from "../src/index";

const SCHEMA = `
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

const memoryStore = {
  id: "memstore_01",
  archivedAt: null,
  createdAt: "2026-08-26T09:00:00.000Z",
  description: "Durable project decisions",
  metadata: { owner: "workspace_01" },
  name: "Project memory",
  updatedAt: "2026-08-26T09:00:00.000Z",
} satisfies MemoryStore;

describe("SqlMemoryStoreStore", () => {
  let client: SqlClient;
  let store: SqlMemoryStoreStore;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA);
    store = new SqlMemoryStoreStore(client);
  });

  it("persists complete SDK-shaped records and replaces them under CAS", async () => {
    await expect(store.insert({ workspaceId: "workspace_01", memoryStore }))
      .resolves.toEqual({ memoryStore, revision: 1 });
    await expect(store.find({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
    })).resolves.toEqual({ memoryStore, revision: 1 });
    await expect(store.find({
      workspaceId: "workspace_other",
      memoryStoreId: memoryStore.id,
    })).resolves.toBeNull();

    const renamed = {
      ...memoryStore,
      name: "Renamed memory",
      updatedAt: "2026-08-26T10:00:00.000Z",
    };
    await expect(store.replace({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
      expectedRevision: 1,
      next: renamed,
    })).resolves.toEqual({
      type: "replaced",
      record: { memoryStore: renamed, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
      expectedRevision: 1,
      next: memoryStore,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
  });

  it("uses inclusive SDK time filters, stable paging, archive, and delete", async () => {
    const second = {
      ...memoryStore,
      id: "memstore_02",
      createdAt: "2026-08-26T10:00:00.000Z",
      updatedAt: "2026-08-26T10:00:00.000Z",
    };
    await store.insert({ workspaceId: "workspace_01", memoryStore });
    await store.insert({ workspaceId: "workspace_01", memoryStore: second });

    await expect(store.list({
      workspaceId: "workspace_01",
      includeArchived: false,
      limit: 10,
      createdAtOrAfter: memoryStore.createdAt,
      createdAtOrBefore: second.createdAt,
      position: {
        createdAt: memoryStore.createdAt,
        memoryStoreId: memoryStore.id,
      },
    })).resolves.toEqual([{ memoryStore: second, revision: 1 }]);
    await expect(store.archive({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
      archivedAt: "2026-08-26T11:00:00.000Z",
    })).resolves.toMatchObject({
      type: "archived",
      record: {
        revision: 2,
        memoryStore: {
          archivedAt: "2026-08-26T11:00:00.000Z",
          updatedAt: "2026-08-26T11:00:00.000Z",
        },
      },
    });
    await expect(store.delete({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
    })).resolves.toEqual({ type: "deleted" });
  });
});
