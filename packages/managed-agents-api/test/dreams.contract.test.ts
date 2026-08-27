import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { DreamsApplicationPort } from "../src/index";
import { dreamView, makeDreamsPort } from "./dream-fixtures";
import { buildDreamsTestApi } from "./test-api";

function makeClient(port: DreamsApplicationPort): Anthropic {
  const api = buildDreamsTestApi(port);
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

describe("Dreams API", () => {
  it("creates a dream with explicit model configuration", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeDreamsPort({
        createDream: async (command) => {
          calls.push(command);
          return { type: "created", dream: dreamView };
        },
      }),
    );

    const dream = await client.beta.dreams.create({
      inputs: [
        { type: "memory_store", memory_store_id: "memstore_01" },
        { type: "sessions", session_ids: ["session_01", "session_02"] },
      ],
      model: { id: "claude-opus-5", speed: "fast" },
      instructions: "Consolidate durable project knowledge",
      output_behavior: {
        type: "update_existing",
        memory_store_id: "memstore_01",
      },
    });

    expect(calls).toEqual([
      {
        inputs: [
          { kind: "memory_store", memoryStoreId: "memstore_01" },
          { kind: "sessions", sessionIds: ["session_01", "session_02"] },
        ],
        model: { modelId: "claude-opus-5", speed: "fast" },
        instructions: "Consolidate durable project knowledge",
        outputBehavior: {
          kind: "update_existing",
          memoryStoreId: "memstore_01",
        },
      },
    ]);
    expect(dream).toEqual({
      id: "dream_01",
      archived_at: null,
      created_at: "2026-08-26T18:00:00.000Z",
      ended_at: null,
      error: null,
      inputs: [
        { type: "memory_store", memory_store_id: "memstore_01" },
        { type: "sessions", session_ids: ["session_01", "session_02"] },
      ],
      instructions: "Consolidate durable project knowledge",
      model: { id: "claude-opus-5", speed: "fast" },
      output_behavior: {
        type: "update_existing",
        memory_store_id: "memstore_01",
      },
      outputs: [{ type: "memory_store", memory_store_id: "memstore_01" }],
      session_id: "session_dream_01",
      status: "running",
      type: "dream",
      usage: {
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
        input_tokens: 300,
        output_tokens: 400,
      },
    });
  });

  it("normalizes the short-form model selector", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeDreamsPort({
        createDream: async (command) => {
          calls.push(command);
          return { type: "created", dream: dreamView };
        },
      }),
    );

    await client.beta.dreams.create({
      inputs: [{ type: "memory_store", memory_store_id: "memstore_01" }],
      model: "claude-opus-5",
    });

    expect(calls).toEqual([
      {
        inputs: [{ kind: "memory_store", memoryStoreId: "memstore_01" }],
        model: { modelId: "claude-opus-5" },
      },
    ]);
  });

  it("retrieves a dream", async () => {
    const calls: unknown[] = [];
    const client = makeClient(
      makeDreamsPort({
        retrieveDream: async (query) => {
          calls.push(query);
          return { type: "found", dream: dreamView };
        },
      }),
    );

    await client.beta.dreams.retrieve("dream_01");

    expect(calls).toEqual([{ dreamId: "dream_01" }]);
  });

  it("lists dreams with all filters and a failed response", async () => {
    const calls: unknown[] = [];
    const failed = {
      ...dreamView,
      status: "failed" as const,
      endedAt: "2026-08-26T18:10:00.000Z",
      error: { type: "pipeline_error", message: "Consolidation failed" },
    };
    const client = makeClient(
      makeDreamsPort({
        listDreams: async (query) => {
          calls.push(query);
          return {
            type: "page",
            page: { dreams: [failed], nextCursor: "dream_page_02" },
          };
        },
      }),
    );

    const page = await client.beta.dreams.list({
      limit: 10,
      page: "dream_page_01",
      "created_at[gt]": "2026-08-01T00:00:00Z",
      "created_at[lt]": "2026-09-01T00:00:00Z",
      include_archived: true,
      statuses: ["running", "failed"],
    });

    expect(calls).toEqual([
      {
        pageSize: 10,
        cursor: "dream_page_01",
        createdAfter: "2026-08-01T00:00:00Z",
        createdBefore: "2026-09-01T00:00:00Z",
        includeArchived: true,
        statuses: ["running", "failed"],
      },
    ]);
    expect(page.data[0]?.error).toEqual({
      type: "pipeline_error",
      message: "Consolidation failed",
    });
    expect(page.next_page).toBe("dream_page_02");
  });

  it.each([
    ["archive", "archiveDream"],
    ["cancel", "cancelDream"],
  ] as const)("maps %s to its dedicated port method", async (operation, method) => {
    const calls: unknown[] = [];
    const port = makeDreamsPort({
      [method]: async (command: { dreamId: string }) => {
        calls.push(command);
        return { type: "changed", dream: dreamView };
      },
    });
    const client = makeClient(port);

    await client.beta.dreams[operation]("dream_01");

    expect(calls).toEqual([{ dreamId: "dream_01" }]);
  });
});
