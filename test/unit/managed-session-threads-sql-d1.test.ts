import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../test-worker";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import {
  SqlSessionEventPersistence,
  SqlSessionPersistence,
  SqlSessionThreadEventPersistence,
  SqlSessionThreadPersistence,
} from "@open-managed-agents/managed-agents-adapters-sql";
import type {
  Session,
  SessionThread,
} from "@open-managed-agents/managed-agents-application";

function db(): D1Database {
  return (env as { MAIN_DB: D1Database }).MAIN_DB;
}

const thread: SessionThread = {
  id: "thread_d1_contract",
  agent: { type: "advisor", model: "claude-opus-5" },
  archivedAt: null,
  createdAt: "2026-08-26T15:00:00.000Z",
  parentThreadId: null,
  sessionId: "session_d1_threads",
  stats: null,
  status: "running",
  updatedAt: "2026-08-26T15:00:00.000Z",
  usage: null,
};

const session: Session = {
  id: thread.sessionId,
  agent: {
    id: "agent_d1_threads",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "D1 thread agent",
    skills: [],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T15:00:00.000Z",
  environmentId: "env_d1_threads",
  metadata: {},
  outcomeEvaluations: [],
  resources: [],
  stats: {},
  status: "running",
  title: null,
  updatedAt: "2026-08-26T15:01:00.000Z",
  usage: {},
  vaultIds: [],
};

beforeAll(async () => {
  await worker.fetch(
    new Request("http://localhost/health"),
    env as unknown as Record<string, unknown>,
    {} as ExecutionContext,
  );
});

describe("Managed Session Thread SQL adapters on Cloudflare D1", () => {
  it("uses the deployed thread table and explicit event relation", async () => {
    const client = new CfD1SqlClient(db());
    await new SqlSessionPersistence(client, {
      seal: async (value: string) => value,
    }).insert({
      workspaceId: "workspace_d1_threads",
      session,
      initialEvents: [],
      resourceSecrets: [],
    });
    await client
      .prepare(
        `INSERT INTO managed_session_threads
          (workspace_id, session_id, id, document, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "workspace_d1_threads",
        thread.sessionId,
        thread.id,
        JSON.stringify(thread),
        Date.parse(thread.createdAt),
        Date.parse(thread.updatedAt),
        null,
      )
      .run();
    const events = new SqlSessionEventPersistence(client);
    await events.append({
      workspaceId: "workspace_d1_threads",
      sessionId: thread.sessionId,
      expectedRevision: 1,
      events: [
        {
          id: "event_d1_thread",
          type: "user.interrupt",
          sessionThreadId: thread.id,
          processedAt: "2026-08-26T15:01:00.000Z",
        },
      ],
      nextSession: session,
    });

    const threads = new SqlSessionThreadPersistence(client);
    const threadEvents = new SqlSessionThreadEventPersistence(client);
    await expect(
      threads.find({
        workspaceId: "workspace_d1_threads",
        sessionId: thread.sessionId,
        threadId: thread.id,
      }),
    ).resolves.toEqual(thread);
    await expect(
      threadEvents.list({
        workspaceId: "workspace_d1_threads",
        sessionId: thread.sessionId,
        threadId: thread.id,
        limit: 10,
      }),
    ).resolves.toMatchObject([
      { id: "event_d1_thread", sessionThreadId: thread.id },
    ]);
  });
});
