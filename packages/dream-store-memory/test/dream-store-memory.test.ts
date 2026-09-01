import { describe, expect, it } from "vitest";
import type { Dream } from "@open-managed-agents/domain/dreams";
import { MemoryDreamStore } from "../src/index";

const dream = {
  id: "dream_01",
  archivedAt: null,
  createdAt: "2026-08-26T09:00:00.000Z",
  endedAt: null,
  error: null,
  inputs: [{ kind: "memory_store", memoryStoreId: "memstore_01" }],
  instructions: "Keep durable decisions",
  model: { modelId: "claude-opus-5", speed: "fast" },
  outputBehavior: { kind: "create_new" },
  outputs: [],
  sessionId: null,
  status: "pending",
  usage: {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
  },
} satisfies Dream;

describe("MemoryDreamStore", () => {
  it("isolates workspaces and returns detached aggregate copies", async () => {
    const store = new MemoryDreamStore();
    const inserted = await store.insert({ workspaceId: "workspace_01", dream });
    inserted.dream.instructions = "mutated by caller";

    await expect(store.find({
      workspaceId: "workspace_01",
      dreamId: dream.id,
    })).resolves.toEqual({ dream, revision: 1 });
    await expect(store.find({
      workspaceId: "workspace_02",
      dreamId: dream.id,
    })).resolves.toBeNull();
  });

  it("lists by lifecycle filters in stable newest-first order", async () => {
    const store = new MemoryDreamStore();
    const completed = {
      ...dream,
      id: "dream_02",
      createdAt: "2026-08-26T10:00:00.000Z",
      endedAt: "2026-08-26T10:30:00.000Z",
      status: "completed",
    } satisfies Dream;
    const archived = {
      ...dream,
      id: "dream_03",
      archivedAt: "2026-08-26T11:30:00.000Z",
      createdAt: "2026-08-26T11:00:00.000Z",
      endedAt: "2026-08-26T11:30:00.000Z",
      status: "completed",
    } satisfies Dream;
    await store.insert({ workspaceId: "workspace_01", dream });
    await store.insert({ workspaceId: "workspace_01", dream: completed });
    await store.insert({ workspaceId: "workspace_01", dream: archived });

    await expect(store.list({
      workspaceId: "workspace_01",
      includeArchived: false,
      limit: 10,
      statuses: ["pending", "completed"],
      createdAfter: "2026-08-26T08:59:59.000Z",
      createdBefore: "2026-08-26T10:30:00.000Z",
    })).resolves.toEqual([
      { dream: completed, revision: 1 },
      { dream, revision: 1 },
    ]);
    await expect(store.list({
      workspaceId: "workspace_01",
      includeArchived: true,
      limit: 10,
      position: { createdAt: completed.createdAt, dreamId: completed.id },
    })).resolves.toEqual([{ dream, revision: 1 }]);
  });

  it("replaces under optimistic concurrency without changing identity", async () => {
    const store = new MemoryDreamStore();
    await store.insert({ workspaceId: "workspace_01", dream });
    const completed = {
      ...dream,
      endedAt: "2026-08-26T09:30:00.000Z",
      status: "completed",
    } satisfies Dream;

    await expect(store.replace({
      workspaceId: "workspace_01",
      dreamId: dream.id,
      expectedRevision: 1,
      next: completed,
    })).resolves.toEqual({
      type: "replaced",
      record: { dream: completed, revision: 2 },
    });
    await expect(store.replace({
      workspaceId: "workspace_01",
      dreamId: dream.id,
      expectedRevision: 1,
      next: dream,
    })).resolves.toEqual({ type: "revision_conflict", actualRevision: 2 });
    await expect(store.replace({
      workspaceId: "workspace_01",
      dreamId: dream.id,
      expectedRevision: 2,
      next: { ...completed, id: "dream_other" },
    })).rejects.toThrow("identity");
  });
});
