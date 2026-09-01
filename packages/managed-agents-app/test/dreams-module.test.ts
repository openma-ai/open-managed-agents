import { describe, expect, it } from "vitest";
import type { Dream } from "@open-managed-agents/domain/dreams";
import { MemoryDreamStore } from "@open-managed-agents/dream-store-memory";

import { createApp, providePort } from "../src/index";
import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../src/capabilities";
import { managedAgentsPortTokens } from "../src/managed-agents";
import {
  dreamExecutionSchedulerPort,
  dreamExecutionPort,
  dreamCuratorPort,
  dreamMemoryStoreSourcePort,
  dreamMemoryWorkspacePort,
  dreamSessionSourcePort,
  dreamStorePort,
  dreamExecutionModule,
  dreamsModule,
} from "../src/modules/dreams";

describe("Dreams application module", () => {
  it("composes the retained service over Store and semantic outbound Ports", async () => {
    const scheduled: string[] = [];
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T12:00:00.000Z"),
        }),
        providePort(idGeneratorPort, {
          next: (namespace) => `${namespace}_01`,
        }),
        providePort(dreamStorePort, new MemoryDreamStore()),
        providePort(dreamMemoryStoreSourcePort, {
          find: async () => ({
            id: "memstore_01",
            archivedAt: null,
            createdAt: "2026-08-26T10:00:00.000Z",
            name: "Project memory",
            updatedAt: "2026-08-26T10:00:00.000Z",
          }),
        }),
        providePort(dreamSessionSourcePort, { find: async () => null }),
        providePort(dreamExecutionSchedulerPort, {
          schedule: async ({ dream }) => {
            scheduled.push(dream.id);
            return { type: "scheduled" as const };
          },
        }),
        dreamsModule(),
      ],
    });
    const dreams = app.port(managedAgentsPortTokens.dreams);

    await expect(dreams.createDream({
      inputs: [{ kind: "memory_store", memoryStoreId: "memstore_01" }],
      model: { modelId: "claude-opus-5" },
    })).resolves.toMatchObject({
      type: "created",
      dream: { id: "dream_01", status: "pending" },
    });
    expect(scheduled).toEqual(["dream_01"]);
  });

  it("composes the retained execution state machine independently of scheduling", async () => {
    const store = new MemoryDreamStore();
    const pending = {
      id: "dream_01",
      archivedAt: null,
      createdAt: "2026-08-26T11:00:00.000Z",
      endedAt: null,
      error: null,
      inputs: [{ kind: "memory_store", memoryStoreId: "memstore_01" }],
      instructions: null,
      model: { modelId: "claude-opus-5" },
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
    await store.insert({ workspaceId: "workspace_01", dream: pending });
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(clockPort, {
          now: () => new Date("2026-08-26T12:00:00.000Z"),
        }),
        providePort(dreamStorePort, store),
        providePort(dreamMemoryWorkspacePort, {
          createOutput: async () => ({
            type: "created" as const,
            memoryStoreId: "memstore_output",
          }),
          readAll: async () => ({ type: "found" as const, memories: [] }),
          replaceAll: async () => ({ type: "replaced" as const }),
        }),
        providePort(dreamCuratorPort, {
          curate: async () => ({
            memories: [],
            usage: {
              cacheCreationInputTokens: 1,
              cacheReadInputTokens: 2,
              inputTokens: 3,
              outputTokens: 4,
            },
          }),
        }),
        providePort(dreamSessionSourcePort, { find: async () => null }),
        dreamExecutionModule(),
      ],
    });

    await expect(app.port(dreamExecutionPort).executeDream({
      dreamId: pending.id,
    })).resolves.toMatchObject({
      type: "completed",
      dream: {
        id: pending.id,
        status: "completed",
        outputs: [{
          kind: "memory_store",
          memoryStoreId: "memstore_output",
        }],
      },
    });
  });
});
