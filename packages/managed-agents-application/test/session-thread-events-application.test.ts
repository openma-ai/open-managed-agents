import { describe, expect, it } from "vitest";
import type {
  SessionEventView,
  StreamSessionEvent,
} from "../src/ports/session-events";
import type { Session } from "../src/domain/session";
import type { SessionThread } from "../src/domain/session-thread";
import { SessionThreadEventsApplicationService } from "../src/index";

const event = (id: string, processedAt: string): SessionEventView => ({
  id,
  type: "session.thread_status_running",
  agentName: "Coding agent",
  processedAt,
  sessionThreadId: "thread_01",
});

const thread: SessionThread = {
  id: "thread_01",
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
  createdAt: "2026-08-26T00:00:00.000Z",
  parentThreadId: null,
  sessionId: "session_01",
  stats: null,
  status: "running",
  updatedAt: "2026-08-26T00:00:00.000Z",
  usage: null,
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

describe("SessionThreadEventsApplicationService", () => {
  it("lists only a known thread and rejects malformed application cursors", async () => {
    const records = [
      event("event_01", "2026-08-26T01:00:00.000Z"),
      event("event_02", "2026-08-26T02:00:00.000Z"),
    ];
    const service = new SessionThreadEventsApplicationService({
      workspaceId: "workspace_01",
      threads: {
        find: async () => ({
          session: structuredClone(session),
          thread: structuredClone(thread),
        }),
      },
      store: {
        listThread: async (input: {
          limit: number;
          position?: { processedAt: string; eventId: string };
        }) =>
          records
            .filter(
              (record) =>
                input.position === undefined ||
                record.processedAt! > input.position.processedAt ||
                (record.processedAt === input.position.processedAt &&
                  record.id > input.position.eventId),
            )
            .slice(0, input.limit),
      },
      stream: { subscribe: () => (async function* () {})() },
    });

    const first = await service.listSessionThreadEvents({
      sessionId: "session_01",
      threadId: "thread_01",
      pageSize: 1,
    });
    if (first.type !== "page") throw new Error("expected event page");
    const second = await service.listSessionThreadEvents({
      sessionId: "session_01",
      threadId: "thread_01",
      pageSize: 1,
      cursor: first.page.nextCursor ?? undefined,
    });

    expect(first).toMatchObject({
      type: "page",
      page: { events: [{ id: "event_01" }], nextCursor: expect.any(String) },
    });
    expect(second).toEqual({
      type: "page",
      page: { events: [records[1]], nextCursor: null },
    });
    await expect(
      service.listSessionThreadEvents({
        sessionId: "session_01",
        threadId: "thread_01",
        cursor: "storage-row-7",
      }),
    ).resolves.toEqual({
      type: "invalid_request",
      message: "Invalid session thread events page cursor",
    });
  });

  it("opens a protocol-neutral stream scoped by workspace, session, and thread", async () => {
    const streamed: StreamSessionEvent[] = [
      {
        id: "event_01",
        type: "session.thread_status_running",
        agentName: "Coding agent",
        processedAt: "2026-08-26T01:00:00.000Z",
        sessionThreadId: "thread_01",
      },
    ];
    const subscriptions: object[] = [];
    const service = new SessionThreadEventsApplicationService({
      workspaceId: "workspace_01",
      threads: {
        find: async ({ threadId }: { threadId: string }) =>
          threadId === "thread_01"
            ? { session: structuredClone(session), thread: structuredClone(thread) }
            : null,
      },
      store: { listThread: async () => [] },
      stream: {
        subscribe(input: object): AsyncIterable<StreamSessionEvent> {
          subscriptions.push(input);
          return (async function* () {
            yield* streamed;
          })();
        },
      },
    });

    const result = await service.streamSessionThreadEvents({
      sessionId: "session_01",
      threadId: "thread_01",
      deltaEventTypes: ["agent.message"],
    });
    if (result.type !== "stream") throw new Error("expected thread stream");
    const received: StreamSessionEvent[] = [];
    for await (const item of result.events) received.push(item);

    expect(subscriptions).toEqual([
      {
        workspaceId: "workspace_01",
        sessionId: "session_01",
        threadId: "thread_01",
        session,
        thread,
        deltaEventTypes: ["agent.message"],
      },
    ]);
    expect(received).toEqual(streamed);
  });
});
