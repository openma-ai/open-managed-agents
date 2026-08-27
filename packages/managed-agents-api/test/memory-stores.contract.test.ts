import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { MemoryStoresApplicationPort } from "../src/index";
import { memoryStoreView, makeMemoryStoresPort } from "./memory-fixtures";
import { buildMemoryTestApi } from "./test-api";

function makeClient(port: MemoryStoresApplicationPort): Anthropic {
  const api = buildMemoryTestApi({ memoryStores: port });
  return new Anthropic({
    apiKey: "test-key",
    baseURL: "http://openma.test",
    maxRetries: 0,
    fetch: async (input, init) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(input.toString(), init);
      return api.fetch(request);
    },
  });
}

describe("Agent Memory API — memory stores", () => {
  it("creates a memory store", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeMemoryStoresPort({
        createMemoryStore: async (command) => {
          calls.push(command);
          return { type: "created", memoryStore: memoryStoreView };
        },
      }),
    );

    const store = await client.beta.memoryStores.create({
      name: "Project memory",
      description: "Project facts",
      metadata: { project: "openma" },
    });

    expect(calls).toEqual([
      {
        name: "Project memory",
        description: "Project facts",
        metadata: { project: "openma" },
      },
    ]);
    expect(store).toEqual({
      id: "memstore_01",
      created_at: "2026-08-26T14:00:00.000Z",
      name: "Project memory",
      type: "memory_store",
      updated_at: "2026-08-26T14:00:00.000Z",
      archived_at: null,
      description: "Project facts",
      metadata: { project: "openma" },
    });
  });

  it("retrieves a memory store", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeMemoryStoresPort({
        retrieveMemoryStore: async (query) => {
          calls.push(query);
          return { type: "found", memoryStore: memoryStoreView };
        },
      }),
    );

    await client.beta.memoryStores.retrieve("memstore_01");

    expect(calls).toEqual([{ memoryStoreId: "memstore_01" }]);
  });

  it("updates nullable fields and metadata patch semantics", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeMemoryStoresPort({
        updateMemoryStore: async (command) => {
          calls.push(command);
          return { type: "updated", memoryStore: memoryStoreView };
        },
      }),
    );

    await client.beta.memoryStores.update("memstore_01", {
      description: null,
      metadata: { owner: "runtime", obsolete: null },
      name: null,
    });

    expect(calls).toEqual([
      {
        memoryStoreId: "memstore_01",
        description: null,
        metadata: { owner: "runtime", obsolete: null },
        name: null,
      },
    ]);
  });

  it("lists stores with timestamp filters and semantic pagination", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeMemoryStoresPort({
        listMemoryStores: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: {
              memoryStores: [memoryStoreView],
              nextCursor: "store_page_02",
            },
          };
        },
      }),
    );

    const page = await client.beta.memoryStores.list({
      limit: 10,
      page: "store_page_01",
      "created_at[gte]": "2026-08-01T00:00:00Z",
      "created_at[lte]": "2026-08-31T23:59:59Z",
      include_archived: true,
    });

    expect(calls).toEqual([
      {
        pageSize: 10,
        cursor: "store_page_01",
        createdAtOrAfter: "2026-08-01T00:00:00Z",
        createdAtOrBefore: "2026-08-31T23:59:59Z",
        includeArchived: true,
      },
    ]);
    expect(page.data[0]?.id).toBe("memstore_01");
    expect(page.next_page).toBe("store_page_02");
  });

  it("deletes a memory store", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeMemoryStoresPort({
        deleteMemoryStore: async (command) => {
          calls.push(command);
          return { type: "deleted", memoryStoreId: "memstore_01" };
        },
      }),
    );

    const deleted = await client.beta.memoryStores.delete("memstore_01");

    expect(calls).toEqual([{ memoryStoreId: "memstore_01" }]);
    expect(deleted).toEqual({
      id: "memstore_01",
      type: "memory_store_deleted",
    });
  });

  it("archives a memory store", async () => {
    const calls: unknown[] = [];
    const archivedStore = {
      ...memoryStoreView,
      archivedAt: "2026-08-26T14:30:00.000Z",
    };
    const client = makeClient(
      makeMemoryStoresPort({
        archiveMemoryStore: async (command) => {
          calls.push(command);
          return { type: "archived", memoryStore: archivedStore };
        },
      }),
    );

    const store = await client.beta.memoryStores.archive("memstore_01");

    expect(calls).toEqual([{ memoryStoreId: "memstore_01" }]);
    expect(store.archived_at).toBe("2026-08-26T14:30:00.000Z");
  });
});
