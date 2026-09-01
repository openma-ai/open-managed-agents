import { describe, expect, it } from "vitest";
import type { DreamStore } from "@open-managed-agents/dream-store";
import {
  DreamExecutionApplicationService,
  type Dream,
  type DreamCuratorPort,
  type DreamMemoryWorkspacePort,
  type DreamSessionSourcePort,
} from "../src";

const pendingDream: Dream = {
  id: "dream_01",
  archivedAt: null,
  createdAt: "2026-08-26T09:00:00.000Z",
  endedAt: null,
  error: null,
  inputs: [{ kind: "memory_store", memoryStoreId: "memstore_input" }],
  instructions: "Keep durable decisions",
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
};

function dependencies(overrides: {
  store?: Partial<DreamStore>;
  memories?: Partial<DreamMemoryWorkspacePort>;
  curator?: Partial<DreamCuratorPort>;
  sessions?: Partial<DreamSessionSourcePort>;
} = {}) {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected ${name} call`);
  };
  return {
    workspaceId: "workspace_01",
    store: {
      insert: unexpected("insert Dream"),
      find: unexpected("find Dream"),
      list: unexpected("list Dreams"),
      replace: unexpected("replace Dream"),
      ...overrides.store,
    } satisfies DreamStore,
    memories: {
      createOutput: unexpected("create output Memory Store"),
      readAll: unexpected("read Dream memories"),
      replaceAll: unexpected("replace Dream memories"),
      ...overrides.memories,
    } satisfies DreamMemoryWorkspacePort,
    curator: {
      curate: unexpected("curate Dream"),
      ...overrides.curator,
    } satisfies DreamCuratorPort,
    sessions: {
      find: unexpected("find Dream Session"),
      ...overrides.sessions,
    } satisfies DreamSessionSourcePort,
    clock: { now: () => new Date("2026-08-26T09:30:00.000Z") },
  };
}

describe("Dream execution application", () => {
  it("moves a pending Dream through running to completed using semantic Ports", async () => {
    let current = { dream: pendingDream, revision: 1 };
    const replacements: Dream[] = [];
    const memoryCalls: object[] = [];
    const service = new DreamExecutionApplicationService(
      dependencies({
        store: {
          find: async () => current,
          replace: async (input) => {
            replacements.push(input.next);
            current = { dream: input.next, revision: current.revision + 1 };
            return { type: "replaced", record: current };
          },
        },
        memories: {
          createOutput: async (input) => {
            memoryCalls.push({ type: "create_output", input });
            return { type: "created", memoryStoreId: "memstore_output" };
          },
          readAll: async (input) => {
            memoryCalls.push({ type: "read_all", input });
            return {
              type: "found",
              memories: [{ path: "/decision.md", content: "Keep API stable" }],
            };
          },
          replaceAll: async (input) => {
            memoryCalls.push({ type: "replace_all", input });
            return { type: "replaced" };
          },
        },
        curator: {
          curate: async (input) => {
            expect(input).toEqual({
              inputMemories: [
                { path: "/decision.md", content: "Keep API stable" },
              ],
              inputSessions: [],
              instructions: "Keep durable decisions",
              model: { modelId: "claude-opus-5" },
            });
            return {
              memories: [
                { path: "/decisions/api.md", content: "Keep API stable" },
              ],
              usage: {
                cacheCreationInputTokens: 1,
                cacheReadInputTokens: 2,
                inputTokens: 3,
                outputTokens: 4,
              },
            };
          },
        },
      }),
    );

    await expect(
      service.executeDream({ dreamId: pendingDream.id }),
    ).resolves.toMatchObject({
      type: "completed",
      dream: {
        id: pendingDream.id,
        status: "completed",
        outputs: [
          { kind: "memory_store", memoryStoreId: "memstore_output" },
        ],
        endedAt: "2026-08-26T09:30:00.000Z",
      },
    });
    expect(replacements.map((dream) => dream.status)).toEqual([
      "running",
      "completed",
    ]);
    expect(memoryCalls).toEqual([
      {
        type: "create_output",
        input: {
          workspaceId: "workspace_01",
          dreamId: "dream_01",
          inputMemoryStoreId: "memstore_input",
        },
      },
      {
        type: "read_all",
        input: {
          workspaceId: "workspace_01",
          memoryStoreId: "memstore_input",
        },
      },
      {
        type: "replace_all",
        input: {
          workspaceId: "workspace_01",
          dreamId: "dream_01",
          memoryStoreId: "memstore_output",
          memories: [
            { path: "/decisions/api.md", content: "Keep API stable" },
          ],
        },
      },
    ]);
  });

  it("records an execution error without overwriting a concurrent cancellation", async () => {
    let current = { dream: pendingDream, revision: 1 };
    const service = new DreamExecutionApplicationService(
      dependencies({
        store: {
          find: async () => current,
          replace: async (input) => {
            if (input.next.status === "running") {
              current = { dream: input.next, revision: 2 };
              return { type: "replaced", record: current };
            }
            current = {
              dream: {
                ...current.dream,
                status: "canceled",
                endedAt: "2026-08-26T09:29:00.000Z",
              },
              revision: 3,
            };
            return { type: "revision_conflict", actualRevision: 3 };
          },
        },
        memories: {
          createOutput: async () => ({
            type: "created",
            memoryStoreId: "memstore_output",
          }),
          readAll: async () => {
            throw new Error("memory backend unavailable");
          },
        },
      }),
    );

    const result = await service.executeDream({ dreamId: pendingDream.id });
    expect(result).toEqual({ type: "skipped", dream: current.dream });
    expect(current.dream.status).toBe("canceled");
  });
});
