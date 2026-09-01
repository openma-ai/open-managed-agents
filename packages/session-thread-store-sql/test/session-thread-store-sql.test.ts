import { beforeEach, describe, expect, it } from "vitest";
import type { SessionThread } from "@open-managed-agents/domain/sessions";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";

import { SqlSessionThreadStore } from "../src/index";

const SCHEMA_SQL = `
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
`;

function thread(id: string, createdAt: string): SessionThread {
  return {
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
  };
}

describe("SqlSessionThreadStore", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("inserts, isolates, and pages complete Session Thread aggregates", async () => {
    const store = new SqlSessionThreadStore(client);
    const first = thread("thread_01", "2026-08-26T01:00:00.000Z");
    const second = thread("thread_02", "2026-08-26T02:00:00.000Z");
    await store.insert({ workspaceId: "workspace_01", thread: first });
    await store.insert({ workspaceId: "workspace_01", thread: second });
    await store.insert({ workspaceId: "workspace_other", thread: first });

    await expect(store.list({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      limit: 10,
      position: { createdAt: first.createdAt, threadId: first.id },
    })).resolves.toEqual([second]);
    await expect(store.find({
      workspaceId: "workspace_other",
      sessionId: "session_01",
      threadId: "thread_02",
    })).resolves.toBeNull();
  });

  it("preserves the first archive transition across retries", async () => {
    const store = new SqlSessionThreadStore(client);
    await store.insert({
      workspaceId: "workspace_01",
      thread: thread("thread_01", "2026-08-26T01:00:00.000Z"),
    });

    await expect(store.archive({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      threadId: "thread_01",
      archivedAt: "2026-08-26T03:00:00.000Z",
    })).resolves.toMatchObject({
      type: "archived",
      transitioned: true,
      thread: { archivedAt: "2026-08-26T03:00:00.000Z" },
    });
    await expect(store.archive({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      threadId: "thread_01",
      archivedAt: "2026-08-26T04:00:00.000Z",
    })).resolves.toMatchObject({
      type: "archived",
      transitioned: false,
      thread: {
        archivedAt: "2026-08-26T03:00:00.000Z",
        updatedAt: "2026-08-26T03:00:00.000Z",
      },
    });
  });
});
