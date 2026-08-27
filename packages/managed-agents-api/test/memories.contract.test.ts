import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { MemoriesApplicationPort } from "../src/index";
import { makeMemoriesPort, memoryView } from "./memory-fixtures";
import { buildMemoryTestApi } from "./test-api";

function makeClient(port: MemoriesApplicationPort): Anthropic {
  const api = buildMemoryTestApi({ memories: port });
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

describe("Agent Memory API — memories", () => {
  it("creates a memory and maps view to projection", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeMemoriesPort({
        createMemory: async (command) => {
          calls.push(command);
          return { type: "created", memory: memoryView };
        },
      }),
    );

    const memory = await client.beta.memoryStores.memories.create(
      "memstore_01",
      { content: "hello", path: "/notes/one.md", view: "full" },
    );

    expect(calls).toEqual([
      {
        memoryStoreId: "memstore_01",
        content: "hello",
        path: "/notes/one.md",
        projection: "full",
      },
    ]);
    expect(memory).toEqual({
      id: "mem_01",
      content_sha256: "a".repeat(64),
      content_size_bytes: 5,
      created_at: "2026-08-26T14:10:00.000Z",
      memory_store_id: "memstore_01",
      memory_version_id: "memver_01",
      path: "/notes/one.md",
      type: "memory",
      updated_at: "2026-08-26T14:10:00.000Z",
      content: "hello",
    });
  });

  it("retrieves a memory through both identifiers", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeMemoriesPort({
        retrieveMemory: async (query) => {
          calls.push(query);
          return { type: "found", memory: memoryView };
        },
      }),
    );

    await client.beta.memoryStores.memories.retrieve("mem_01", {
      memory_store_id: "memstore_01",
      view: "full",
    });

    expect(calls).toEqual([
      {
        memoryStoreId: "memstore_01",
        memoryId: "mem_01",
        projection: "full",
      },
    ]);
  });

  it("updates content, path, and SHA-256 precondition", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeMemoriesPort({
        updateMemory: async (command) => {
          calls.push(command);
          return { type: "updated", memory: memoryView };
        },
      }),
    );

    await client.beta.memoryStores.memories.update("mem_01", {
      memory_store_id: "memstore_01",
      view: "basic",
      content: null,
      path: "/notes/renamed.md",
      precondition: {
        type: "content_sha256",
        content_sha256: "b".repeat(64),
      },
    });

    expect(calls).toEqual([
      {
        memoryStoreId: "memstore_01",
        memoryId: "mem_01",
        projection: "basic",
        content: null,
        path: "/notes/renamed.md",
        contentPrecondition: { expectedSha256: "b".repeat(64) },
      },
    ]);
  });

  it("lists memories and prefix rollups", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeMemoriesPort({
        listMemories: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: {
              items: [memoryView, { kind: "prefix", path: "/notes/deeper/" }],
              nextCursor: "memory_page_02",
            },
          };
        },
      }),
    );

    const page = await client.beta.memoryStores.memories.list("memstore_01", {
      limit: 20,
      page: "memory_page_01",
      depth: 1,
      path_prefix: "/notes/",
      view: "full",
    });

    expect(calls).toEqual([
      {
        memoryStoreId: "memstore_01",
        pageSize: 20,
        cursor: "memory_page_01",
        depth: 1,
        pathPrefix: "/notes/",
        projection: "full",
      },
    ]);
    expect(page.data.map((item) => item.type)).toEqual([
      "memory",
      "memory_prefix",
    ]);
    expect(page.next_page).toBe("memory_page_02");
  });

  it("deletes a memory with an expected digest", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeMemoriesPort({
        deleteMemory: async (command) => {
          calls.push(command);
          return { type: "deleted", memoryId: "mem_01" };
        },
      }),
    );

    const deleted = await client.beta.memoryStores.memories.delete("mem_01", {
      memory_store_id: "memstore_01",
      expected_content_sha256: "a".repeat(64),
    });

    expect(calls).toEqual([
      {
        memoryStoreId: "memstore_01",
        memoryId: "mem_01",
        expectedContentSha256: "a".repeat(64),
      },
    ]);
    expect(deleted).toEqual({ id: "mem_01", type: "memory_deleted" });
  });

  it("preserves the memory precondition failure error type", async () => {
    const client = makeClient(
      makeMemoriesPort({
        updateMemory: async () => ({
          type: "precondition_failed",
          message: "memory changed",
        }),
      }),
    );

    await expect(
      client.beta.memoryStores.memories.update("mem_01", {
        memory_store_id: "memstore_01",
        precondition: {
          type: "content_sha256",
          content_sha256: "b".repeat(64),
        },
      }),
    ).rejects.toMatchObject({
      status: 409,
      type: "memory_precondition_failed_error",
      error: {
        type: "error",
        error: {
          type: "memory_precondition_failed_error",
          message: "memory changed",
        },
      },
    });
  });

  it("preserves path conflict details", async () => {
    const client = makeClient(
      makeMemoriesPort({
        createMemory: async () => ({
          type: "path_conflict",
          conflict: {
            message: "path already exists",
            conflictingMemoryId: "mem_existing",
            conflictingPath: "/notes/one.md",
          },
        }),
      }),
    );

    await expect(
      client.beta.memoryStores.memories.create("memstore_01", {
        content: "hello",
        path: "/notes/one.md",
      }),
    ).rejects.toMatchObject({
      status: 409,
      type: "memory_path_conflict_error",
      error: {
        type: "error",
        error: {
          type: "memory_path_conflict_error",
          message: "path already exists",
          conflicting_memory_id: "mem_existing",
          conflicting_path: "/notes/one.md",
        },
      },
    });
  });
});
