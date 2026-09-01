import { describe, expect, it } from "vitest";
import type { Session } from "../src/domain/session";
import type { SessionThread } from "../src/domain/session-thread";
import { SessionThreadsApplicationService } from "../src/index";

const thread = (id: string, createdAt: string): SessionThread => ({
  id,
  agent: {
    type: "agent",
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  createdAt,
  parentThreadId: null,
  sessionId: "session_01",
  stats: null,
  status: "running",
  updatedAt: createdAt,
  usage: null,
});

const silentThreadLifecycle = {
  sessionThreadArchived: async () => {},
};

const session: Session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Coding agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: {},
  vaultIds: [],
};

describe("SessionThreadsApplicationService", () => {
  it("lists tenant-scoped threads through an application-owned cursor", async () => {
    const records = [
      thread("thread_01", "2026-08-26T01:00:00.000Z"),
      thread("thread_02", "2026-08-26T02:00:00.000Z"),
    ];
    const service = new SessionThreadsApplicationService({
      workspaceId: "workspace_01",
      sessions: { find: async () => structuredClone(session) },
      store: {
        insert: async ({ thread: value }) => structuredClone(value),
        find: async () => null,
        archive: async () => ({ type: "not_found" as const }),
        list: async (input: {
          workspaceId: string;
          sessionId: string;
          limit: number;
          position?: { createdAt: string; threadId: string };
        }) =>
          records
            .filter(
              (record) =>
                input.position === undefined ||
                record.createdAt > input.position.createdAt ||
                (record.createdAt === input.position.createdAt &&
                  record.id > input.position.threadId),
            )
            .slice(0, input.limit),
      },
      lifecycle: silentThreadLifecycle,
      clock: { now: () => new Date("2026-08-26T03:00:00.000Z") },
    });

    const first = await service.listSessionThreads({
      sessionId: "session_01",
      pageSize: 1,
    });
    if (first.type !== "page") throw new Error("expected thread page");
    const second = await service.listSessionThreads({
      sessionId: "session_01",
      pageSize: 1,
      cursor: first.page.nextCursor ?? undefined,
    });

    expect(first).toMatchObject({
      type: "page",
      page: { threads: [{ id: "thread_01" }], nextCursor: expect.any(String) },
    });
    expect(second).toEqual({
      type: "page",
      page: { threads: [records[1]], nextCursor: null },
    });
  });

  it("checks session and thread ownership before retrieval and atomic archive", async () => {
    const archiveInputs: object[] = [];
    const lifecycleSignals: object[] = [];
    const service = new SessionThreadsApplicationService({
      workspaceId: "workspace_01",
      sessions: {
        find: async ({ sessionId }: { sessionId: string }) =>
          sessionId === "session_01" ? structuredClone(session) : null,
      },
      store: {
        insert: async ({ thread: value }) => structuredClone(value),
        list: async () => [],
        find: async (input: {
          workspaceId: string;
          sessionId: string;
          threadId: string;
        }) =>
          input.workspaceId === "workspace_01" &&
          input.sessionId === "session_01" &&
          input.threadId === "thread_01"
            ? thread("thread_01", "2026-08-26T01:00:00.000Z")
            : null,
        archive: async (input: object) => {
          archiveInputs.push(input);
          return {
            type: "archived" as const,
            transitioned: true,
            thread: {
              ...thread("thread_01", "2026-08-26T01:00:00.000Z"),
              archivedAt: "2026-08-26T03:00:00.000Z",
              updatedAt: "2026-08-26T03:00:00.000Z",
            },
          };
        },
      },
      lifecycle: {
        sessionThreadArchived: async (input: object) => {
          lifecycleSignals.push(input);
        },
      },
      clock: { now: () => new Date("2026-08-26T03:00:00.000Z") },
    });

    await expect(
      service.retrieveSessionThread({
        sessionId: "session_other",
        threadId: "thread_01",
      }),
    ).resolves.toEqual({ type: "not_found" });
    await expect(
      service.retrieveSessionThread({
        sessionId: "session_01",
        threadId: "thread_01",
      }),
    ).resolves.toMatchObject({ type: "found", thread: { id: "thread_01" } });
    await expect(
      service.archiveSessionThread({
        sessionId: "session_01",
        threadId: "thread_01",
      }),
    ).resolves.toMatchObject({
      type: "archived",
      thread: { archivedAt: "2026-08-26T03:00:00.000Z" },
    });
    expect(archiveInputs).toEqual([
      {
        workspaceId: "workspace_01",
        sessionId: "session_01",
        threadId: "thread_01",
        archivedAt: "2026-08-26T03:00:00.000Z",
      },
    ]);
    expect(lifecycleSignals).toEqual([
      {
        workspaceId: "workspace_01",
        sessionId: "session_01",
        threadId: "thread_01",
        session,
        thread: expect.objectContaining({
          id: "thread_01",
          archivedAt: "2026-08-26T03:00:00.000Z",
        }),
      },
    ]);
  });
});
