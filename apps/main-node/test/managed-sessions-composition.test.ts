import { ensureSessionExecutionCoordinatorSchema } from "@open-managed-agents/session-runtime-sql/coordination";
import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  Agent,
  Environment,
  SessionLifecycleCommandPort,
} from "@open-managed-agents/managed-agents-application";
import {
  SqlManagedSessionsComposition,
  SqlAgentPersistence,
  SqlSessionEnvironmentSource,
  type SqlManagedSessionsRuntime,
} from "@open-managed-agents/managed-agents-adapters-sql";
import { SqlSessionThreadStore } from "@open-managed-agents/session-thread-store-sql";

const SCHEMA = `
CREATE TABLE managed_agent_versions (
  agent_id text NOT NULL, workspace_id text NOT NULL, version integer NOT NULL,
  document text NOT NULL, created_at integer NOT NULL,
  PRIMARY KEY (agent_id, version)
);
CREATE TABLE managed_agents (
  id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, document text NOT NULL,
  version integer NOT NULL, created_at integer NOT NULL,
  updated_at integer NOT NULL, archived_at integer
);
CREATE TABLE managed_sessions (
  id text PRIMARY KEY NOT NULL, workspace_id text NOT NULL, document text NOT NULL,
  revision integer NOT NULL, agent_id text NOT NULL, agent_version integer NOT NULL,
  environment_id text NOT NULL, deployment_id text, status text NOT NULL,
  created_at integer NOT NULL, updated_at integer NOT NULL, archived_at integer
);
CREATE TABLE managed_session_events (
  workspace_id text NOT NULL, session_id text NOT NULL, thread_id text,
  id text NOT NULL, type text NOT NULL, document text NOT NULL,
  processed_at integer NOT NULL,
  PRIMARY KEY (workspace_id, session_id, id)
);
CREATE TABLE managed_session_threads (
  workspace_id text NOT NULL, session_id text NOT NULL, id text NOT NULL,
  document text NOT NULL, created_at integer NOT NULL,
  updated_at integer NOT NULL, archived_at integer,
  PRIMARY KEY (workspace_id, session_id, id)
);
CREATE TABLE managed_environments (
  workspace_id text NOT NULL, id text NOT NULL, document text NOT NULL,
  revision integer NOT NULL, created_at integer NOT NULL,
  updated_at integer NOT NULL, archived_at integer,
  PRIMARY KEY (workspace_id, id)
);
`;

const agent: Agent = {
  id: "agent_01",
  archivedAt: null,
  createdAt: "2026-08-26T00:00:00.000Z",
  description: null,
  mcpServers: [],
  metadata: {},
  model: { id: "claude-opus-5" },
  multiagent: null,
  name: "Coding agent",
  skills: [],
  system: null,
  tools: [],
  updatedAt: "2026-08-26T00:00:00.000Z",
  version: 1,
};

const environment: Environment = {
  id: "env_01",
  archivedAt: null,
  config: { type: "self_hosted" },
  createdAt: "2026-08-25T00:00:00.000Z",
  description: null,
  metadata: {},
  name: "Node runtime",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

describe("SqlManagedSessionsComposition", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA);
    await new SqlAgentPersistence(client).insert({
      workspaceId: "workspace_01",
      agent,
    });
    await client
      .prepare(
        `INSERT INTO managed_environments
          (workspace_id, id, document, revision, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, 1, ?, ?, NULL)`,
      )
      .bind(
        "workspace_01",
        environment.id,
        JSON.stringify(environment),
        Date.parse(environment.createdAt),
        Date.parse(environment.updatedAt),
      )
      .run();
  });

  it.each(["self_hosted", "cloud"] as const)("only queues Node execution for cloud environments: %s", async (type) => {
    await ensureSessionExecutionCoordinatorSchema(client);
    await client.exec(`CREATE TABLE managed_session_initial_events (session_id TEXT, workspace_id TEXT, sequence INTEGER, document TEXT);`);
    const routedEnvironment = { ...environment, config: type === "self_hosted"
      ? { type: "self_hosted" as const }
      : { type: "cloud" as const, networking: { type: "unrestricted" as const }, packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] } } };
    await client.prepare("UPDATE managed_environments SET document = ?").bind(JSON.stringify(routedEnvironment)).run();
    const composition = new SqlManagedSessionsComposition({
      client, executionOutbox: true,
      environments: new SqlSessionEnvironmentSource(client),
      lifecycle: { sessionStarted: async () => {}, sessionStopped: async () => {} },
      runtime: { sessionEventsAccepted: async () => {}, sessionThreadArchived: async () => {}, subscribe: () => (async function* () {})() },
      sealer: { seal: async value => value },
      clock: { now: () => new Date("2026-08-26T01:00:00.000Z") },
      ids: { nextSessionId: () => "session_routed", nextEventId: () => "event_routed", nextOutcomeId: () => "outcome", nextResourceId: () => "resource" },
    });
    const ports = composition.portsFor("workspace_01");
    await expect(ports.sessions.createSession({ agent: { type: "latest", agentId: agent.id }, environmentId: environment.id,
      initialEvents: [{ type: "user.message", content: [{ type: "text", text: "First" }] }],
    })).resolves.toMatchObject({ type: "created" });
    await expect(ports.sessionEvents.sendSessionEvents({ sessionId: "session_routed", events: [{ type: "user.message", content: [{ type: "text", text: "Continue" }] }] })).resolves.toMatchObject({ type: "accepted" });
    await expect(client.prepare("SELECT COUNT(*) AS count FROM managed_session_executions").first()).resolves.toEqual({ count: type === "cloud" ? 2 : 0 });
    await expect(client.prepare("SELECT COUNT(*) AS count FROM managed_session_events").first()).resolves.toEqual({ count: 1 });
    await composition.stopAll();
  });

  it("reuses one tenant-scoped application graph while isolating workspaces", () => {
    const composition = new SqlManagedSessionsComposition({
      client,
      environments: new SqlSessionEnvironmentSource(client),
      lifecycle: {
        sessionStarted: async () => {},
        sessionStopped: async () => {},
      },
      runtime: {
        sessionEventsAccepted: async () => {},
        sessionThreadArchived: async () => {},
        subscribe: () => (async function* () {})(),
      },
      sealer: { seal: async (value) => `sealed:${value}` },
      clock: { now: () => new Date("2026-08-26T01:00:00.000Z") },
      ids: {
        nextSessionId: () => "session_01",
        nextEventId: () => "sevt_01",
        nextOutcomeId: () => "outc_01",
        nextResourceId: () => "sesrsc_01",
      },
    });

    const first = composition.portsFor("workspace_01");
    const second = composition.portsFor("workspace_01");
    const other = composition.portsFor("workspace_02");

    expect(second).toBe(first);
    expect(second.sessions).toBe(first.sessions);
    expect(other).not.toBe(first);
    expect(other.sessions).not.toBe(first.sessions);
  });

  it("uses an explicitly composed event stream independently from runtime dispatch", async () => {
    const streamCalls: object[] = [];
    const composition = new SqlManagedSessionsComposition({
      client,
      environments: new SqlSessionEnvironmentSource(client),
      lifecycle: {
        sessionStarted: async () => {},
        sessionStopped: async () => {},
      },
      runtime: {
        sessionEventsAccepted: async () => {},
        sessionThreadArchived: async () => {},
        subscribe: () => {
          throw new Error("runtime stream must not be selected");
        },
      },
      eventStream: {
        subscribe: (input) => {
          streamCalls.push(input);
          return (async function* () {
            yield { type: "event_start", eventId: "stream_01" } as never;
          })();
        },
      },
      sealer: { seal: async (value) => `sealed:${value}` },
      clock: { now: () => new Date("2026-08-26T01:00:00.000Z") },
      ids: {
        nextSessionId: () => "session_01",
        nextEventId: () => "sevt_01",
        nextOutcomeId: () => "outc_01",
        nextResourceId: () => "sesrsc_01",
      },
    });
    const ports = composition.portsFor("workspace_01");
    await ports.sessions.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: environment.id,
    });

    const streamed = await ports.sessionEvents.streamSessionEvents({
      sessionId: "session_01",
    });
    expect(streamed.type).toBe("stream");
    if (streamed.type !== "stream") throw new Error("expected stream");
    await expect(streamed.events[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: false,
      value: { type: "event_start", eventId: "stream_01" },
    });
    expect(streamCalls).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_01",
        sessionId: "session_01",
      }),
    ]);
  });

  it("dispatches events with an archived Environment snapshot already referenced by the Session", async () => {
    const dispatches: unknown[] = [];
    const lifecycleStarts: unknown[] = [];
    const lifecycle: SessionLifecycleCommandPort = {
      sessionStarted: async (input) => {
        lifecycleStarts.push(structuredClone(input));
      },
      sessionStopped: async () => {},
    };
    const runtime: SqlManagedSessionsRuntime = {
      sessionEventsAccepted: async (input) => {
        dispatches.push(structuredClone(input));
      },
      sessionThreadArchived: async () => {},
      subscribe: () => (async function* () {})(),
    };
    let nextEvent = 0;
    const composition = new SqlManagedSessionsComposition({
      client,
      environments: new SqlSessionEnvironmentSource(client),
      lifecycle,
      runtime,
      sealer: { seal: async (value) => `sealed:${value}` },
      clock: { now: () => new Date("2026-08-26T01:00:00.000Z") },
      ids: {
        nextSessionId: () => "session_01",
        nextEventId: () => `sevt_0${++nextEvent}`,
        nextOutcomeId: () => "outc_01",
        nextResourceId: () => "sesrsc_01",
      },
    });
    const ports = composition.portsFor("workspace_01");
    await expect(
      ports.sessions.createSession({
        agent: { type: "latest", agentId: agent.id },
        environmentId: environment.id,
      }),
    ).resolves.toMatchObject({ type: "created" });
    expect(lifecycleStarts).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_01",
        session: expect.objectContaining({ id: "session_01" }),
        environment: expect.objectContaining({ id: environment.id }),
      }),
    ]);
    const archivedAt = "2026-08-26T02:00:00.000Z";
    await client
      .prepare(
        `UPDATE managed_environments
            SET archived_at = ?, updated_at = ?
          WHERE workspace_id = ? AND id = ?`,
      )
      .bind(
        Date.parse(archivedAt),
        Date.parse(archivedAt),
        "workspace_01",
        environment.id,
      )
      .run();

    const sent = await ports.sessionEvents.sendSessionEvents({
      sessionId: "session_01",
      events: [
        { type: "user.message", content: [{ type: "text", text: "Continue" }] },
      ],
    });

    expect(sent).toMatchObject({ type: "accepted" });
    expect(dispatches).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_01",
        sessionId: "session_01",
        environment: expect.objectContaining({
          id: environment.id,
          archivedAt,
        }),
      }),
    ]);
  });

  it("emits the Session Thread archive lifecycle only for the first transition", async () => {
    const archived: unknown[] = [];
    const composition = new SqlManagedSessionsComposition({
      client,
      environments: new SqlSessionEnvironmentSource(client),
      lifecycle: {
        sessionStarted: async () => {},
        sessionStopped: async () => {},
      },
      runtime: {
        sessionEventsAccepted: async () => {},
        sessionThreadArchived: async (input) => {
          archived.push(structuredClone(input));
        },
        subscribe: () => (async function* () {})(),
      },
      sealer: { seal: async (value) => `sealed:${value}` },
      clock: { now: () => new Date("2026-08-26T03:00:00.000Z") },
      ids: {
        nextSessionId: () => "session_01",
        nextEventId: () => "sevt_01",
        nextOutcomeId: () => "outc_01",
        nextResourceId: () => "sesrsc_01",
      },
    });
    const ports = composition.portsFor("workspace_01");
    await ports.sessions.createSession({
      agent: { type: "latest", agentId: agent.id },
      environmentId: environment.id,
    });
    await new SqlSessionThreadStore(client).insert({
      workspaceId: "workspace_01",
      thread: {
        id: "thread_01",
        agent: { ...agent, type: "agent" },
        archivedAt: null,
        createdAt: "2026-08-26T02:00:00.000Z",
        parentThreadId: null,
        sessionId: "session_01",
        stats: null,
        status: "running",
        updatedAt: "2026-08-26T02:00:00.000Z",
        usage: null,
      },
    });

    await ports.sessionThreads.archiveSessionThread({
      sessionId: "session_01",
      threadId: "thread_01",
    });
    await ports.sessionThreads.archiveSessionThread({
      sessionId: "session_01",
      threadId: "thread_01",
    });

    expect(archived).toHaveLength(1);
    expect(archived).toEqual([
      expect.objectContaining({
        workspaceId: "workspace_01",
        sessionId: "session_01",
        threadId: "thread_01",
      }),
    ]);
  });
});
