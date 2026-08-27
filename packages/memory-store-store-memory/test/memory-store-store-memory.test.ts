import { describe, expect, it } from "vitest";
import type { MemoryStore } from "@open-managed-agents/domain/memory-stores";
import { InMemoryMemoryStoreStore } from "../src/index";

const memoryStore = {
  id: "memstore_01",
  archivedAt: null,
  createdAt: "2026-08-26T09:00:00.000Z",
  description: "Durable project decisions",
  metadata: { owner: "workspace_01" },
  name: "Project memory",
  updatedAt: "2026-08-26T09:00:00.000Z",
} satisfies MemoryStore;

describe("InMemoryMemoryStoreStore", () => {
  it("isolates workspaces and returns detached SDK-shaped records", async () => {
    const store = new InMemoryMemoryStoreStore();
    const inserted = await store.insert({
      workspaceId: "workspace_01",
      memoryStore,
    });
    inserted.memoryStore.metadata!.owner = "mutated";

    await expect(store.find({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
    })).resolves.toEqual({ memoryStore, revision: 1 });
    await expect(store.find({
      workspaceId: "workspace_02",
      memoryStoreId: memoryStore.id,
    })).resolves.toBeNull();
  });

  it("lists inclusive time bounds in stable oldest-first order", async () => {
    const store = new InMemoryMemoryStoreStore();
    const second = {
      ...memoryStore,
      id: "memstore_02",
      createdAt: "2026-08-26T10:00:00.000Z",
      updatedAt: "2026-08-26T10:00:00.000Z",
    } satisfies MemoryStore;
    const archived = {
      ...memoryStore,
      id: "memstore_03",
      archivedAt: "2026-08-26T11:30:00.000Z",
      createdAt: "2026-08-26T11:00:00.000Z",
      updatedAt: "2026-08-26T11:30:00.000Z",
    } satisfies MemoryStore;
    await store.insert({ workspaceId: "workspace_01", memoryStore });
    await store.insert({ workspaceId: "workspace_01", memoryStore: second });
    await store.insert({ workspaceId: "workspace_01", memoryStore: archived });

    await expect(store.list({
      workspaceId: "workspace_01",
      includeArchived: false,
      limit: 10,
      createdAtOrAfter: memoryStore.createdAt,
      createdAtOrBefore: second.createdAt,
    })).resolves.toEqual([
      { memoryStore, revision: 1 },
      { memoryStore: second, revision: 1 },
    ]);
    await expect(store.list({
      workspaceId: "workspace_01",
      includeArchived: true,
      limit: 10,
      position: { createdAt: second.createdAt, memoryStoreId: second.id },
    })).resolves.toEqual([{ memoryStore: archived, revision: 1 }]);
  });

  it("replaces under CAS, then archives and deletes the same record", async () => {
    const store = new InMemoryMemoryStoreStore();
    await store.insert({ workspaceId: "workspace_01", memoryStore });
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
    await expect(store.archive({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
      archivedAt: "2026-08-26T11:00:00.000Z",
    })).resolves.toMatchObject({
      type: "archived",
      record: {
        revision: 3,
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
    await expect(store.find({
      workspaceId: "workspace_01",
      memoryStoreId: memoryStore.id,
    })).resolves.toBeNull();
  });
});
