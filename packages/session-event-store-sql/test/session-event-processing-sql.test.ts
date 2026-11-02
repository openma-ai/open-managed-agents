import { beforeEach, describe, expect, it } from "vitest";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import { sessionEventSortTime } from "@open-managed-agents/session-event-store";
import type { SentSessionEvent } from "@open-managed-agents/domain/sessions";

import { SqlSessionEventStore } from "../src/index";

const SCHEMA_SQL = `
CREATE TABLE managed_sessions (
  workspace_id text NOT NULL, id text NOT NULL, document text NOT NULL,
  revision integer NOT NULL, status text, updated_at integer,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE managed_session_events (
  workspace_id text NOT NULL, session_id text NOT NULL, thread_id text,
  id text NOT NULL, type text NOT NULL, document text NOT NULL,
  processed_at integer NOT NULL,
  PRIMARY KEY (workspace_id, session_id, id)
);
`;

const session = (updatedAt: string) => ({
  id: "session_01", environmentId: "env_01", status: "running", updatedAt,
}) as never;

describe("SqlSessionEventStore queued input processing", () => {
  let client: SqlClient;
  let store: SqlSessionEventStore;
  let revision = 1;

  async function append(events: SentSessionEvent[], acceptedAt: string) {
    const result = await store.append({
      workspaceId: "w", sessionId: "session_01", expectedRevision: revision,
      events, nextSession: session(acceptedAt),
    });
    expect(result.type).toBe("appended");
    revision += 1;
  }

  async function list() {
    return store.list({ workspaceId: "w", sessionId: "session_01", limit: 20, order: "asc" });
  }

  beforeEach(async () => {
    revision = 1;
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
    await client.prepare(
      "INSERT INTO managed_sessions VALUES ('w', 'session_01', '{}', 1, 'running', 0)",
    ).run();
    store = new SqlSessionEventStore(client);
  });

  it("keeps a queued input null at its acceptance position, then stamps and repositions it once", async () => {
    await append([{ id: "q1", type: "user.message", content: [{ type: "text", text: "queued" }], processedAt: null }],
      "2026-08-26T01:00:00.000Z");
    await append([{ id: "r1", type: "user.tool_result", toolUseId: "t", processedAt: "2026-08-26T02:00:00.000Z" }],
      "2026-08-26T02:00:00.000Z");

    const before = await list();
    expect(before.map((event) => [event.id, event.processedAt])).toEqual([["q1", null], ["r1", "2026-08-26T02:00:00.000Z"]]);
    expect(sessionEventSortTime(before[0]!)).toBe("2026-08-26T01:00:00.000Z");

    const marked = await store.markProcessed({
      workspaceId: "w", sessionId: "session_01", eventIds: ["q1", "missing"],
      processedAt: "2026-08-26T03:00:00.000Z",
    });
    expect(marked).toEqual([{ id: "q1", type: "user.message", content: [{ type: "text", text: "queued" }],
      processedAt: "2026-08-26T03:00:00.000Z" }]);

    const after = await list();
    expect(after.map((event) => [event.id, event.processedAt])).toEqual([
      ["r1", "2026-08-26T02:00:00.000Z"], ["q1", "2026-08-26T03:00:00.000Z"],
    ]);

    // Idempotent: a second stamp keeps the first processing time.
    const again = await store.markProcessed({
      workspaceId: "w", sessionId: "session_01", eventIds: ["q1"],
      processedAt: "2026-08-26T04:00:00.000Z",
    });
    expect(again[0]?.processedAt).toBe("2026-08-26T03:00:00.000Z");
  });
});
