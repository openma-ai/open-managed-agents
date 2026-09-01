import { describe, expect, it } from "vitest";
import type { SessionEventLogStore } from "@open-managed-agents/session-event-store";
import type {
  SentSessionEvent,
  StreamSessionEvent,
} from "../src/ports/session-events";
import type { Session } from "../src/domain/session";
import type { Environment } from "../src/domain/environment";
import { SessionEventsApplicationService } from "../src/index";

class MemorySessionEventStore implements SessionEventLogStore {
  private readonly events: SentSessionEvent[] = [];
  readonly appendCalls: object[] = [];

  async append(input: {
    workspaceId: string;
    sessionId: string;
    expectedRevision: number;
    events: SentSessionEvent[];
    nextSession: Session;
  }): Promise<{
    type: "appended";
    events: SentSessionEvent[];
    session: Session;
  }> {
    this.appendCalls.push(structuredClone(input));
    this.events.push(...structuredClone(input.events));
    return {
      type: "appended",
      events: structuredClone(input.events),
      session: structuredClone(input.nextSession),
    };
  }

  async list(input: {
    workspaceId: string;
    sessionId: string;
    limit: number;
    order: "asc" | "desc";
    position?: { processedAt: string; eventId: string };
  }): Promise<SentSessionEvent[]> {
    const multiplier = input.order === "asc" ? 1 : -1;
    return this.events
      .filter((event) => event.processedAt != null)
      .filter((event) => {
        if (input.position === undefined) return true;
        const comparison =
          multiplier *
          (event.processedAt!.localeCompare(input.position.processedAt) ||
            event.id.localeCompare(input.position.eventId));
        return comparison > 0;
      })
      .sort(
        (left, right) =>
          multiplier *
          (left.processedAt!.localeCompare(right.processedAt!) ||
            left.id.localeCompare(right.id)),
      )
      .slice(0, input.limit)
      .map((event) => structuredClone(event));
  }
}

const emptySessionEventStream = {
  subscribe(): AsyncIterable<StreamSessionEvent> {
    return (async function* () {})();
  },
};

const silentEventDispatch = {
  sessionEventsAccepted: async () => {},
};

const activeSession: Session = {
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
  createdAt: "2026-08-26T04:00:00.000Z",
  environmentId: "env_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T04:00:00.000Z",
  usage: {},
  vaultIds: [],
};

const executionEnvironment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-26T03:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-08-26T03:00:00.000Z",
};

describe("SessionEventsApplicationService", () => {
  it("assigns semantic IDs and processing time before appending events", async () => {
    let nextEvent = 0;
    const dispatchSignals: object[] = [];
    const store = new MemorySessionEventStore();
    const service = new SessionEventsApplicationService({
      workspaceId: "workspace_01",
      store,
      sessions: {
        find: async (input: { workspaceId: string; sessionId: string }) =>
          input.workspaceId === "workspace_01" &&
          input.sessionId === "session_01"
            ? structuredClone(activeSession)
            : null,
      },
      execution: {
        find: async () => ({
          session: structuredClone(activeSession),
          environment: structuredClone(executionEnvironment),
          revision: 7,
        }),
      },
      stream: emptySessionEventStream,
      dispatch: {
        sessionEventsAccepted: async (input: object) => {
          dispatchSignals.push(input);
        },
      },
      clock: { now: () => new Date("2026-08-26T05:00:00.000Z") },
      ids: {
        nextEventId: () => `event_0${++nextEvent}`,
        nextOutcomeId: () => "outcome_01",
      },
    });

    const result = await service.sendSessionEvents({
      sessionId: "session_01",
      events: [
        {
          type: "system.message",
          content: [{ type: "text", text: "Use the checklist" }],
        },
        {
          type: "user.define_outcome",
          description: "Migration complete",
          rubric: { type: "file", fileId: "file_rubric" },
          maxIterations: 4,
        },
      ],
    });

    expect(result).toEqual({
      type: "accepted",
      events: [
        {
          id: "event_01",
          type: "system.message",
          content: [{ type: "text", text: "Use the checklist" }],
          processedAt: "2026-08-26T05:00:00.000Z",
        },
        {
          id: "event_02",
          type: "user.define_outcome",
          description: "Migration complete",
          rubric: { type: "file", fileId: "file_rubric" },
          maxIterations: 4,
          outcomeId: "outcome_01",
          processedAt: "2026-08-26T05:00:00.000Z",
        },
      ],
    });
    const nextSession = {
      ...activeSession,
      outcomeEvaluations: [{
        type: "outcome_evaluation" as const,
        completedAt: null,
        description: "Migration complete",
        explanation: null,
        iteration: 0,
        outcomeId: "outcome_01",
        result: "pending",
      }],
      updatedAt: "2026-08-26T05:00:00.000Z",
    };
    expect(store.appendCalls).toEqual([{
      workspaceId: "workspace_01",
      sessionId: "session_01",
      expectedRevision: 7,
      events: result.type === "accepted" ? result.events : [],
      nextSession,
    }]);
    expect(dispatchSignals).toEqual([
      {
        workspaceId: "workspace_01",
        sessionId: "session_01",
        session: nextSession,
        environment: executionEnvironment,
        events: result.type === "accepted" ? result.events : [],
      },
    ]);
  });

  it("lists event history through an application-owned stable cursor", async () => {
    let now = new Date("2026-08-26T05:00:00.000Z");
    let nextEvent = 0;
    const service = new SessionEventsApplicationService({
      workspaceId: "workspace_01",
      store: new MemorySessionEventStore(),
      sessions: { find: async () => structuredClone(activeSession) },
      execution: {
        find: async () => ({
          session: structuredClone(activeSession),
          environment: structuredClone(executionEnvironment),
          revision: 1,
        }),
      },
      stream: emptySessionEventStream,
      dispatch: silentEventDispatch,
      clock: { now: () => now },
      ids: {
        nextEventId: () => `event_0${++nextEvent}`,
        nextOutcomeId: () => "outcome_unused",
      },
    });
    await service.sendSessionEvents({
      sessionId: "session_01",
      events: [{ type: "system.message", content: [{ type: "text", text: "First" }] }],
    });
    now = new Date("2026-08-26T06:00:00.000Z");
    await service.sendSessionEvents({
      sessionId: "session_01",
      events: [{ type: "system.message", content: [{ type: "text", text: "Second" }] }],
    });

    const first = await service.listSessionEvents({
      sessionId: "session_01",
      pageSize: 1,
      order: "desc",
    });
    if (first.type !== "page") throw new Error("expected first events page");
    const second = await service.listSessionEvents({
      sessionId: "session_01",
      pageSize: 1,
      order: "desc",
      cursor: first.page.nextCursor ?? undefined,
    });

    expect(first).toMatchObject({
      type: "page",
      page: {
        events: [{ id: "event_02", content: [{ text: "Second" }] }],
        nextCursor: expect.any(String),
      },
    });
    expect(second).toEqual({
      type: "page",
      page: {
        events: [
          {
            id: "event_01",
            type: "system.message",
            content: [{ type: "text", text: "First" }],
            processedAt: "2026-08-26T05:00:00.000Z",
          },
        ],
        nextCursor: null,
      },
    });
  });

  it("opens an application stream without leaking a transport protocol", async () => {
    const streamed: StreamSessionEvent[] = [
      {
        id: "event_01",
        type: "session.status_running",
        processedAt: "2026-08-26T07:00:00.000Z",
      },
      {
        type: "event_start",
        event: { id: "event_02", type: "agent.message" },
      },
    ];
    const subscriptions: object[] = [];
    const service = new SessionEventsApplicationService({
      workspaceId: "workspace_01",
      store: new MemorySessionEventStore(),
      sessions: { find: async () => structuredClone(activeSession) },
      execution: {
        find: async () => ({
          session: structuredClone(activeSession),
          environment: structuredClone(executionEnvironment),
          revision: 1,
        }),
      },
      stream: {
        subscribe(input: object): AsyncIterable<StreamSessionEvent> {
          subscriptions.push(input);
          return (async function* () {
            yield* streamed;
          })();
        },
      },
      dispatch: silentEventDispatch,
      clock: { now: () => new Date("2026-08-26T07:00:00.000Z") },
      ids: {
        nextEventId: () => "event_unused",
        nextOutcomeId: () => "outcome_unused",
      },
    });

    const result = await service.streamSessionEvents({
      sessionId: "session_01",
      deltaEventTypes: ["agent.message"],
    });
    if (result.type !== "stream") throw new Error("expected event stream");
    const received: StreamSessionEvent[] = [];
    for await (const event of result.events) received.push(event);

    expect(subscriptions).toEqual([
      {
        workspaceId: "workspace_01",
        sessionId: "session_01",
        session: activeSession,
        deltaEventTypes: ["agent.message"],
      },
    ]);
    expect(received).toEqual(streamed);
  });
});
