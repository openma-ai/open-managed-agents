import { describe, expect, it } from "vitest";
import {
  ApplicationDreamMemoryWorkspace,
  AnthropicMessagesDreamCurator,
  DeduplicatingDreamCurator,
  InProcessDreamExecutionScheduler,
  inProcessDreamExecutionSchedulerModule,
} from "../src";
import { createApp, providePort } from "@open-managed-agents/app";
import { workspaceContextPort } from "@open-managed-agents/app/capabilities";
import {
  dreamExecutionPort,
  dreamExecutionSchedulerPort,
} from "@open-managed-agents/app/modules/dreams";
import type {
  DreamExecutionApplicationPort,
  MemoriesApplicationPort,
  MemoryStoresApplicationPort,
} from "@open-managed-agents/managed-agents-application";

function memoryStores(
  overrides: Partial<MemoryStoresApplicationPort> = {},
): MemoryStoresApplicationPort {
  const unexpected = async () => {
    throw new Error("unexpected Memory Stores call");
  };
  return {
    createMemoryStore: unexpected,
    retrieveMemoryStore: unexpected,
    updateMemoryStore: unexpected,
    listMemoryStores: unexpected,
    deleteMemoryStore: unexpected,
    archiveMemoryStore: unexpected,
    ...overrides,
  };
}

function memories(
  overrides: Partial<MemoriesApplicationPort> = {},
): MemoriesApplicationPort {
  const unexpected = async () => {
    throw new Error("unexpected Memories call");
  };
  return {
    createMemory: unexpected,
    retrieveMemory: unexpected,
    updateMemory: unexpected,
    listMemories: unexpected,
    deleteMemory: unexpected,
    ...overrides,
  };
}

describe("Dream execution runtime adapters", () => {
  it("installs the in-process scheduler as a strict app module", async () => {
    const executions: object[] = [];
    let deferred: Promise<void> | null = null;
    const app = createApp({
      modules: [
        providePort(workspaceContextPort, { workspaceId: "workspace_01" }),
        providePort(dreamExecutionPort, {
          executeDream: async (command) => {
            executions.push(command);
            return { type: "not_found" as const };
          },
        }),
        inProcessDreamExecutionSchedulerModule({
          defer: (task) => {
            deferred = task;
          },
        }),
      ],
    });

    await expect(app.port(dreamExecutionSchedulerPort).schedule({
      workspaceId: "workspace_01",
      dream: {
        id: "dream_01",
        archivedAt: null,
        createdAt: "2026-08-26T09:00:00.000Z",
        endedAt: null,
        error: null,
        inputs: [],
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
      },
    })).resolves.toEqual({ type: "scheduled" });
    await deferred;
    expect(executions).toEqual([{ dreamId: "dream_01" }]);
  });

  it("defers a scoped execution and does not run when deferral is rejected", async () => {
    const executions: object[] = [];
    const execution: DreamExecutionApplicationPort = {
      executeDream: async (command) => {
        executions.push(command);
        return { type: "not_found" };
      },
    };
    let deferred: Promise<void> | null = null;
    const scheduler = new InProcessDreamExecutionScheduler({
      workspaceId: "workspace_01",
      execution,
      defer: (task) => {
        deferred = task;
      },
    });

    await expect(
      scheduler.schedule({
        workspaceId: "workspace_01",
        dream: {
          id: "dream_01",
          archivedAt: null,
          createdAt: "2026-08-26T09:00:00.000Z",
          endedAt: null,
          error: null,
          inputs: [],
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
        },
      }),
    ).resolves.toEqual({ type: "scheduled" });
    await deferred;
    expect(executions).toEqual([{ dreamId: "dream_01" }]);

    const rejected = new InProcessDreamExecutionScheduler({
      workspaceId: "workspace_01",
      execution,
      defer: () => {
        throw new Error("waitUntil unavailable");
      },
    });
    await expect(
      rejected.schedule({
        workspaceId: "workspace_01",
        dream: {
          id: "dream_02",
          archivedAt: null,
          createdAt: "2026-08-26T09:00:00.000Z",
          endedAt: null,
          error: null,
          inputs: [],
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
        },
      }),
    ).resolves.toEqual({ type: "rejected", message: "waitUntil unavailable" });
    await Promise.resolve();
    expect(executions).toHaveLength(1);
  });

  it("replaces an output Memory Store through the narrow workspace Port", async () => {
    const mutations: Array<{ type: string; [key: string]: unknown }> = [];
    let listCall = 0;
    const workspace = new ApplicationDreamMemoryWorkspace({
      workspaceId: "workspace_01",
      memoryStores: memoryStores({
        createMemoryStore: async (command) => {
          mutations.push({ type: "create_store", command });
          return {
            type: "created",
            memoryStore: {
              id: "memstore_output",
              archivedAt: null,
              createdAt: "2026-08-26T09:00:00.000Z",
              name: command.name,
              updatedAt: "2026-08-26T09:00:00.000Z",
            },
          };
        },
      }),
      memories: memories({
        listMemories: async () => {
          listCall += 1;
          return listCall === 1
            ? {
                type: "page",
                page: {
                  items: [
                    {
                      kind: "memory",
                      id: "mem_keep",
                      content: "old",
                      contentSha256: "old-sha",
                      contentSizeBytes: 3,
                      createdAt: "2026-08-26T09:00:00.000Z",
                      memoryStoreId: "memstore_output",
                      memoryVersionId: "memver_keep",
                      path: "/keep.md",
                      updatedAt: "2026-08-26T09:00:00.000Z",
                    },
                    {
                      kind: "memory",
                      id: "mem_drop",
                      content: "drop",
                      contentSha256: "drop-sha",
                      contentSizeBytes: 4,
                      createdAt: "2026-08-26T09:00:00.000Z",
                      memoryStoreId: "memstore_output",
                      memoryVersionId: "memver_drop",
                      path: "/drop.md",
                      updatedAt: "2026-08-26T09:00:00.000Z",
                    },
                  ],
                  nextCursor: null,
                },
              }
            : { type: "page", page: { items: [], nextCursor: null } };
        },
        updateMemory: async (command) => {
          mutations.push({ type: "update", command });
          return {
            type: "updated",
            memory: {
              kind: "memory",
              id: command.memoryId,
              contentSha256: "new-sha",
              contentSizeBytes: 3,
              createdAt: "2026-08-26T09:00:00.000Z",
              memoryStoreId: command.memoryStoreId,
              memoryVersionId: "memver_new",
              path: command.path ?? "/keep.md",
              updatedAt: "2026-08-26T09:01:00.000Z",
            },
          };
        },
        createMemory: async (command) => {
          mutations.push({ type: "create", command });
          return {
            type: "created",
            memory: {
              kind: "memory",
              id: "mem_new",
              contentSha256: "new-sha",
              contentSizeBytes: 3,
              createdAt: "2026-08-26T09:00:00.000Z",
              memoryStoreId: command.memoryStoreId,
              memoryVersionId: "memver_new",
              path: command.path,
              updatedAt: "2026-08-26T09:00:00.000Z",
            },
          };
        },
        deleteMemory: async (command) => {
          mutations.push({ type: "delete", command });
          return { type: "deleted", memoryId: command.memoryId };
        },
      }),
    });

    await expect(
      workspace.createOutput({
        workspaceId: "workspace_01",
        dreamId: "dream_01",
        inputMemoryStoreId: "memstore_input",
      }),
    ).resolves.toEqual({
      type: "created",
      memoryStoreId: "memstore_output",
    });
    await expect(
      workspace.replaceAll({
        workspaceId: "workspace_01",
        dreamId: "dream_01",
        memoryStoreId: "memstore_output",
        memories: [
          { path: "/keep.md", content: "new" },
          { path: "/new.md", content: "new" },
        ],
      }),
    ).resolves.toEqual({ type: "replaced" });
    expect(mutations.map((call) => call.type)).toEqual([
      "create_store",
      "update",
      "create",
      "delete",
    ]);
  });

  it("deduplicates curated memories by path with deterministic ordering", async () => {
    const curator = new DeduplicatingDreamCurator();
    await expect(
      curator.curate({
        inputMemories: [
          { path: "/z.md", content: "old" },
          { path: "/a.md", content: "a" },
          { path: "/z.md", content: "new" },
        ],
        inputSessions: [],
        instructions: null,
        model: { modelId: "claude-opus-5" },
      }),
    ).resolves.toEqual({
      memories: [
        { path: "/a.md", content: "a" },
        { path: "/z.md", content: "new" },
      ],
      usage: {
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    });
  });

  it("curates through Anthropic Messages using the Dream model and semantic usage", async () => {
    const requests: Request[] = [];
    const curator = new AnthropicMessagesDreamCurator({
      apiKey: "sk-ant-test",
      baseUrl: "https://anthropic.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                memories: [
                  { path: "/curated.md", content: "Durable decision" },
                ],
              }),
            },
          ],
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 5,
          },
        });
      },
    });

    await expect(
      curator.curate({
        inputMemories: [{ path: "/input.md", content: "raw" }],
        inputSessions: [{ id: "session_01", title: "Architecture" }],
        instructions: "Keep decisions",
        model: { modelId: "claude-opus-5", speed: "fast" },
      }),
    ).resolves.toEqual({
      memories: [{ path: "/curated.md", content: "Durable decision" }],
      usage: {
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 5,
        inputTokens: 11,
        outputTokens: 7,
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://anthropic.example/v1/messages");
    expect(requests[0]!.headers.get("x-api-key")).toBe("sk-ant-test");
    expect(await requests[0]!.json()).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 8192,
      messages: [{ role: "user" }],
    });
  });
});
