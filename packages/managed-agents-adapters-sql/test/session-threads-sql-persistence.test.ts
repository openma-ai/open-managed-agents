import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  Session,
  SessionEventView,
  SessionThread,
} from "@open-managed-agents/managed-agents-application";
import {
  SqlSessionThreadContextSource,
  SqlSessionThreadEventPersistence,
  SqlSessionThreadPersistence,
} from "../src";

const SCHEMA_SQL = `
CREATE TABLE managed_sessions (
  id text PRIMARY KEY NOT NULL,
  workspace_id text NOT NULL,
  document text NOT NULL,
  revision integer NOT NULL,
  agent_id text NOT NULL,
  agent_version integer NOT NULL,
  environment_id text NOT NULL,
  deployment_id text,
  status text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer
);
CREATE TABLE managed_session_threads (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  id text NOT NULL,
  document text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  archived_at integer,
  PRIMARY KEY (workspace_id, session_id, id)
);
CREATE INDEX idx_managed_session_threads_workspace_session_created_id
  ON managed_session_threads (workspace_id, session_id, created_at, id);
CREATE TABLE managed_session_events (
  workspace_id text NOT NULL,
  session_id text NOT NULL,
  thread_id text,
  id text NOT NULL,
  type text NOT NULL,
  document text NOT NULL,
  processed_at integer NOT NULL,
  PRIMARY KEY (workspace_id, session_id, id)
);
CREATE INDEX idx_managed_session_events_workspace_thread_time_id
  ON managed_session_events (workspace_id, session_id, thread_id, processed_at, id);
`;

const makeThread = (id: string, createdAt: string): SessionThread => ({
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

describe("Managed Session Thread SQL persistence", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  async function insertThread(
    workspaceId: string,
    value: SessionThread,
  ): Promise<void> {
    await client
      .prepare(
        `INSERT INTO managed_session_threads
          (workspace_id, session_id, id, document, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        workspaceId,
        value.sessionId,
        value.id,
        JSON.stringify(value),
        Date.parse(value.createdAt),
        Date.parse(value.updatedAt),
        null,
      )
      .run();
  }

  async function insertSession(workspaceId: string): Promise<void> {
    await client
      .prepare(
        `INSERT INTO managed_sessions
          (id, workspace_id, document, revision, agent_id, agent_version,
           environment_id, deployment_id, status, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        session.id,
        workspaceId,
        JSON.stringify(session),
        1,
        session.agent.id,
        session.agent.version,
        session.environmentId,
        null,
        session.status,
        Date.parse(session.createdAt),
        Date.parse(session.updatedAt),
        null,
      )
      .run();
  }

  it("finds, pages, and atomically archives within workspace and session", async () => {
    const first = makeThread("thread_01", "2026-08-26T01:00:00.000Z");
    const second = makeThread("thread_02", "2026-08-26T02:00:00.000Z");
    await insertThread("workspace_01", first);
    await insertThread("workspace_01", second);
    await insertThread("workspace_other", first);
    const persistence = new SqlSessionThreadPersistence(client);

    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        sessionId: "session_01",
        limit: 10,
        position: { createdAt: first.createdAt, threadId: first.id },
      }),
    ).resolves.toEqual([second]);
    await expect(
      persistence.find({
        workspaceId: "workspace_other",
        sessionId: "session_01",
        threadId: "thread_02",
      }),
    ).resolves.toBeNull();
    await insertSession("workspace_01");
    await expect(
      new SqlSessionThreadContextSource(client).find({
        workspaceId: "workspace_01",
        sessionId: "session_01",
        threadId: "thread_01",
      }),
    ).resolves.toEqual({ session, thread: first });
    await expect(
      persistence.archive({
        workspaceId: "workspace_01",
        sessionId: "session_01",
        threadId: "thread_01",
        archivedAt: "2026-08-26T03:00:00.000Z",
      }),
    ).resolves.toMatchObject({
      type: "archived",
      thread: {
        id: "thread_01",
        archivedAt: "2026-08-26T03:00:00.000Z",
        updatedAt: "2026-08-26T03:00:00.000Z",
      },
    });
  });

  it("lists event documents only through the explicit thread relation", async () => {
    const linked: SessionEventView = {
      id: "event_01",
      type: "agent.message",
      content: [{ type: "text", text: "Thread response" }],
      processedAt: "2026-08-26T01:00:00.000Z",
    };
    const other: SessionEventView = {
      id: "event_02",
      type: "agent.message",
      content: [{ type: "text", text: "Other thread" }],
      processedAt: "2026-08-26T02:00:00.000Z",
    };
    for (const [threadId, value] of [
      ["thread_01", linked],
      ["thread_02", other],
    ] as const) {
      await client
        .prepare(
          `INSERT INTO managed_session_events
            (workspace_id, session_id, thread_id, id, type, document, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "workspace_01",
          "session_01",
          threadId,
          value.id,
          value.type,
          JSON.stringify(value),
          Date.parse(value.processedAt!),
        )
        .run();
    }

    const persistence = new SqlSessionThreadEventPersistence(client);
    await expect(
      persistence.list({
        workspaceId: "workspace_01",
        sessionId: "session_01",
        threadId: "thread_01",
        limit: 10,
      }),
    ).resolves.toEqual([linked]);
    await expect(
      persistence.list({
        workspaceId: "workspace_other",
        sessionId: "session_01",
        threadId: "thread_01",
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });
});
