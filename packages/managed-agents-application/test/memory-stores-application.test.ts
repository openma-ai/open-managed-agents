import { describe, expect, it } from "vitest";
import type { MemoryStore } from "@open-managed-agents/domain/memory-stores";
import type { MemoryStoreStore } from "@open-managed-agents/memory-store-store";
import { MemoryStoresApplicationService } from "../src/index";

interface StoredMemoryStore {
  memoryStore: MemoryStore;
  revision: number;
}

class InMemoryMemoryStoreStore implements MemoryStoreStore {
  private readonly records = new Map<string, StoredMemoryStore>();

  async insert(input: {
    workspaceId: string;
    memoryStore: MemoryStore;
  }): Promise<StoredMemoryStore> {
    const record = { memoryStore: structuredClone(input.memoryStore), revision: 1 };
    this.records.set(`${input.workspaceId}:${input.memoryStore.id}`, record);
    return structuredClone(record);
  }

  async find(input: {
    workspaceId: string;
    memoryStoreId: string;
  }): Promise<StoredMemoryStore | null> {
    const record = this.records.get(`${input.workspaceId}:${input.memoryStoreId}`);
    return record === undefined ? null : structuredClone(record);
  }

  async replace(input: {
    workspaceId: string;
    memoryStoreId: string;
    expectedRevision: number;
    next: MemoryStore;
  }): Promise<
    | { type: "replaced"; record: StoredMemoryStore }
    | { type: "not_found" }
    | { type: "revision_conflict"; actualRevision: number }
  > {
    const key = `${input.workspaceId}:${input.memoryStoreId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" };
    if (current.revision !== input.expectedRevision) {
      return { type: "revision_conflict", actualRevision: current.revision };
    }
    const record = {
      memoryStore: structuredClone(input.next),
      revision: current.revision + 1,
    };
    this.records.set(key, record);
    return { type: "replaced", record: structuredClone(record) };
  }

  async archive(input: {
    workspaceId: string;
    memoryStoreId: string;
    archivedAt: string;
  }): Promise<
    | { type: "archived"; record: StoredMemoryStore }
    | { type: "not_found" }
  > {
    const key = `${input.workspaceId}:${input.memoryStoreId}`;
    const current = this.records.get(key);
    if (current === undefined) return { type: "not_found" };
    const record = {
      memoryStore: {
        ...current.memoryStore,
        archivedAt: input.archivedAt,
        updatedAt: input.archivedAt,
      },
      revision: current.revision + 1,
    };
    this.records.set(key, structuredClone(record));
    return { type: "archived", record: structuredClone(record) };
  }

  async delete(input: {
    workspaceId: string;
    memoryStoreId: string;
  }): Promise<{ type: "deleted" } | { type: "not_found" }> {
    return this.records.delete(`${input.workspaceId}:${input.memoryStoreId}`)
      ? { type: "deleted" }
      : { type: "not_found" };
  }

  async list(input: {
    workspaceId: string;
    limit: number;
    includeArchived: boolean;
    createdAtOrAfter?: string;
    createdAtOrBefore?: string;
    position?: { createdAt: string; memoryStoreId: string };
  }): Promise<StoredMemoryStore[]> {
    return Array.from(this.records.entries())
      .filter(([key]) => key.startsWith(`${input.workspaceId}:`))
      .map(([, record]) => record)
      .filter(
        (record) =>
          input.includeArchived || record.memoryStore.archivedAt === null,
      )
      .filter(
        (record) =>
          input.createdAtOrAfter === undefined ||
          record.memoryStore.createdAt >= input.createdAtOrAfter,
      )
      .filter(
        (record) =>
          input.createdAtOrBefore === undefined ||
          record.memoryStore.createdAt <= input.createdAtOrBefore,
      )
      .filter(
        (record) =>
          input.position === undefined ||
          record.memoryStore.createdAt > input.position.createdAt ||
          (record.memoryStore.createdAt === input.position.createdAt &&
            record.memoryStore.id > input.position.memoryStoreId),
      )
      .sort(
        (left, right) =>
          left.memoryStore.createdAt.localeCompare(right.memoryStore.createdAt) ||
          left.memoryStore.id.localeCompare(right.memoryStore.id),
      )
      .slice(0, input.limit)
      .map((record) => structuredClone(record));
  }
}

describe("MemoryStoresApplicationService", () => {
  it("creates and patches a tenant-scoped store with official null semantics", async () => {
    let now = new Date("2026-08-26T16:00:00.000Z");
    const service = new MemoryStoresApplicationService({
      workspaceId: "workspace_01",
      store: new InMemoryMemoryStoreStore(),
      clock: { now: () => now },
      ids: { nextMemoryStoreId: () => "memstore_01" },
    });

    const created = await service.createMemoryStore({
      name: "Project memory",
      description: "Initial facts",
      metadata: { owner: "platform", obsolete: "remove" },
    });
    now = new Date("2026-08-26T17:00:00.000Z");
    const updated = await service.updateMemoryStore({
      memoryStoreId: "memstore_01",
      name: null,
      description: null,
      metadata: { owner: "runtime", obsolete: null },
    });

    expect(created).toMatchObject({
      type: "created",
      memoryStore: {
        id: "memstore_01",
        name: "Project memory",
        archivedAt: null,
      },
    });
    expect(updated).toEqual({
      type: "updated",
      memoryStore: {
        id: "memstore_01",
        name: "Project memory",
        createdAt: "2026-08-26T16:00:00.000Z",
        updatedAt: "2026-08-26T17:00:00.000Z",
        archivedAt: null,
        metadata: { owner: "runtime" },
      },
    });
    await expect(
      service.retrieveMemoryStore({ memoryStoreId: "memstore_01" }),
    ).resolves.toEqual(updated.type === "updated"
      ? { type: "found", memoryStore: updated.memoryStore }
      : { type: "not_found" });
  });

  it("lists through an application cursor and archives then deletes", async () => {
    let now = new Date("2026-08-26T16:00:00.000Z");
    let nextId = 0;
    const service = new MemoryStoresApplicationService({
      workspaceId: "workspace_01",
      store: new InMemoryMemoryStoreStore(),
      clock: { now: () => now },
      ids: { nextMemoryStoreId: () => `memstore_0${++nextId}` },
    });
    await service.createMemoryStore({ name: "First" });
    now = new Date("2026-08-26T17:00:00.000Z");
    await service.createMemoryStore({ name: "Second" });

    const first = await service.listMemoryStores({ pageSize: 1 });
    if (first.type !== "page") throw new Error("expected memory store page");
    const second = await service.listMemoryStores({
      pageSize: 1,
      cursor: first.page.nextCursor ?? undefined,
    });
    expect(first).toMatchObject({
      type: "page",
      page: {
        memoryStores: [{ id: "memstore_01" }],
        nextCursor: expect.any(String),
      },
    });
    expect(second).toMatchObject({
      type: "page",
      page: { memoryStores: [{ id: "memstore_02" }], nextCursor: null },
    });

    now = new Date("2026-08-26T18:00:00.000Z");
    await expect(
      service.archiveMemoryStore({ memoryStoreId: "memstore_01" }),
    ).resolves.toMatchObject({
      type: "archived",
      memoryStore: { archivedAt: "2026-08-26T18:00:00.000Z" },
    });
    await expect(
      service.deleteMemoryStore({ memoryStoreId: "memstore_01" }),
    ).resolves.toEqual({ type: "deleted", memoryStoreId: "memstore_01" });
  });

  it("rejects metadata outside the official bounded bag", async () => {
    const service = new MemoryStoresApplicationService({
      workspaceId: "workspace_01",
      store: new InMemoryMemoryStoreStore(),
      clock: { now: () => new Date("2026-08-26T16:00:00.000Z") },
      ids: { nextMemoryStoreId: () => "memstore_01" },
    });

    await expect(
      service.createMemoryStore({
        name: "Too much metadata",
        metadata: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`key${index}`, "value"]),
        ),
      }),
    ).resolves.toEqual({
      type: "invalid_request",
      message: "Memory store metadata may contain at most 16 keys",
    });
  });
});
