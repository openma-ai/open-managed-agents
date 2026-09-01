import { describe, expect, it } from "vitest";
import type { DreamStore, StoredDream } from "@open-managed-agents/dream-store";
import {
  DreamsApplicationService,
  type Dream,
  type DreamExecutionSchedulerPort,
  type DreamMemoryStoreSourcePort,
  type DreamSessionSourcePort,
  type MemoryStore,
  type Session,
} from "../src";

const memoryStore = {
  id: "memstore_01",
  archivedAt: null,
  createdAt: "2026-08-26T08:00:00.000Z",
  name: "Project memory",
  updatedAt: "2026-08-26T08:00:00.000Z",
} satisfies MemoryStore;

const session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: "2026-08-26T08:30:00.000Z",
  budget: null,
  createdAt: "2026-08-26T08:10:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "idle",
  title: null,
  updatedAt: "2026-08-26T08:30:00.000Z",
  usage: {},
  vaultIds: [],
} satisfies Session;

const pendingDream = {
  id: "dream_01",
  archivedAt: null,
  createdAt: "2026-08-26T09:00:00.000Z",
  endedAt: null,
  error: null,
  inputs: [
    { kind: "memory_store", memoryStoreId: memoryStore.id },
    { kind: "sessions", sessionIds: [session.id] },
  ],
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

const storedDream = {
  dream: pendingDream,
  revision: 3,
} satisfies StoredDream;

function dependencies(overrides: {
  store?: Partial<DreamStore>;
  memoryStores?: Partial<DreamMemoryStoreSourcePort>;
  sessions?: Partial<DreamSessionSourcePort>;
  execution?: Partial<DreamExecutionSchedulerPort>;
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
    memoryStores: {
      find: unexpected("find Dream memory store"),
      ...overrides.memoryStores,
    } satisfies DreamMemoryStoreSourcePort,
    sessions: {
      find: unexpected("find Dream Session"),
      ...overrides.sessions,
    } satisfies DreamSessionSourcePort,
    execution: {
      schedule: unexpected("schedule Dream execution"),
      ...overrides.execution,
    } satisfies DreamExecutionSchedulerPort,
    clock: { now: () => new Date("2026-08-26T09:00:00.000Z") },
    ids: { nextDreamId: () => "dream_01" },
  };
}

describe("Dreams application", () => {
  it("resolves complete inputs, inserts a pending aggregate, then schedules it", async () => {
    const sourceCalls: object[] = [];
    const insertCalls: object[] = [];
    const scheduleCalls: object[] = [];
    const service = new DreamsApplicationService(
      dependencies({
        memoryStores: {
          find: async (input) => {
            sourceCalls.push({ type: "memory_store", input });
            return memoryStore;
          },
        },
        sessions: {
          find: async (input) => {
            sourceCalls.push({ type: "session", input });
            return session;
          },
        },
        store: {
          insert: async (input) => {
            insertCalls.push(input);
            return { dream: input.dream, revision: 1 };
          },
        },
        execution: {
          schedule: async (input) => {
            scheduleCalls.push(input);
            return { type: "scheduled" };
          },
        },
      }),
    );

    await expect(
      service.createDream({
        inputs: pendingDream.inputs,
        instructions: pendingDream.instructions,
        model: pendingDream.model,
      }),
    ).resolves.toEqual({ type: "created", dream: pendingDream });
    expect(sourceCalls).toEqual([
      {
        type: "memory_store",
        input: { workspaceId: "workspace_01", memoryStoreId: "memstore_01" },
      },
      {
        type: "session",
        input: { workspaceId: "workspace_01", sessionId: "session_01" },
      },
    ]);
    expect(insertCalls).toEqual([
      { workspaceId: "workspace_01", dream: pendingDream },
    ]);
    expect(scheduleCalls).toEqual([
      { workspaceId: "workspace_01", dream: pendingDream },
    ]);
  });

  it("rejects a missing or archived memory-store dependency before persistence", async () => {
    const service = new DreamsApplicationService(
      dependencies({
        memoryStores: { find: async () => ({ ...memoryStore, archivedAt: "2026-08-26T08:30:00.000Z" }) },
      }),
    );

    await expect(
      service.createDream({
        inputs: [{ kind: "memory_store", memoryStoreId: memoryStore.id }],
        model: { modelId: "claude-opus-5" },
      }),
    ).resolves.toEqual({
      type: "dependency_not_found",
      message: "Memory store memstore_01 was not found",
    });
  });

  it("cancels only non-terminal Dreams under optimistic concurrency", async () => {
    const replaceCalls: object[] = [];
    const service = new DreamsApplicationService(
      dependencies({
        store: {
          find: async () => storedDream,
          replace: async (input) => {
            replaceCalls.push(input);
            return { type: "replaced", record: { dream: input.next, revision: 4 } };
          },
        },
      }),
    );

    await expect(
      service.cancelDream({ dreamId: pendingDream.id }),
    ).resolves.toEqual({
      type: "changed",
      dream: {
        ...pendingDream,
        status: "canceled",
        endedAt: "2026-08-26T09:00:00.000Z",
      },
    });
    expect(replaceCalls).toEqual([
      {
        workspaceId: "workspace_01",
        dreamId: "dream_01",
        expectedRevision: 3,
        next: {
          ...pendingDream,
          status: "canceled",
          endedAt: "2026-08-26T09:00:00.000Z",
        },
      },
    ]);
  });

  it("archives only terminal Dreams and preserves their lifecycle status", async () => {
    const completed = {
      ...storedDream,
      dream: {
        ...pendingDream,
        endedAt: "2026-08-26T09:30:00.000Z",
        status: "completed" as const,
      },
    };
    const service = new DreamsApplicationService(
      dependencies({
        store: {
          find: async () => completed,
          replace: async (input) => ({
            type: "replaced",
            record: { dream: input.next, revision: 4 },
          }),
        },
      }),
    );

    await expect(
      service.archiveDream({ dreamId: pendingDream.id }),
    ).resolves.toEqual({
      type: "changed",
      dream: {
        ...completed.dream,
        archivedAt: "2026-08-26T09:00:00.000Z",
      },
    });
  });
});
