import { beforeEach, describe, expect, it } from "vitest";
import type { SessionEventView } from "@open-managed-agents/domain/sessions";
import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";

import { SqlSessionEventStore } from "../src/index";

const SCHEMA_SQL = `
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

describe("SqlSessionEventStore thread reader", () => {
  let client: SqlClient;

  beforeEach(async () => {
    client = await createBetterSqlite3SqlClient(":memory:");
    await client.exec(SCHEMA_SQL);
  });

  it("uses the stored thread relation even when it is absent from the event document", async () => {
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
    for (const [threadId, event] of [
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
          event.id,
          event.type,
          JSON.stringify(event),
          Date.parse(event.processedAt!),
        )
        .run();
    }

    const store = new SqlSessionEventStore(client);
    await expect(store.listThread({
      workspaceId: "workspace_01",
      sessionId: "session_01",
      threadId: "thread_01",
      limit: 10,
    })).resolves.toEqual([linked]);
    await expect(store.listThread({
      workspaceId: "workspace_other",
      sessionId: "session_01",
      threadId: "thread_01",
      limit: 10,
    })).resolves.toEqual([]);
  });
});
