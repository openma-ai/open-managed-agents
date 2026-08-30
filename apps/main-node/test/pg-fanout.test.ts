// PG-mode end-to-end smoke for the event log + LISTEN/NOTIFY hub.
//
// Runs through the repository storage integration project, which owns a
// disposable PostgreSQL container. It asserts:
//   1. ensureSchema(sql, "postgres") + SqlEventLog.appendAsync /
//      getEventsAsync round-trip cleanly on Postgres.
//   2. SqlStreamRepo.start (ON CONFLICT DO NOTHING) + appendChunk
//      (jsonb_build_array path) + finalize work end-to-end.
//   3. PgEventStreamHub fans out across two in-process hub instances
//      sharing the same DSN — replica B's writer receives the event
//      replica A published, within a tight latency budget.
//
// Run locally with `pnpm test:integration:storage`.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPostgresSqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import {
  SqlEventLog,
  SqlStreamRepo,
  ensureSchema as ensureEventLogSchema,
} from "@open-managed-agents/event-log/sql";
import type { SessionEvent } from "@open-managed-agents/shared";
import { getStorageIntegrationConfig } from "../../../test/storage-integration.js";
import { PgEventStreamHub } from "../src/lib/pg-event-stream-hub";
import type { EventWriter } from "../src/lib/event-stream-hub";

const PG_URL = getStorageIntegrationConfig().postgres.eventFanout;

let sql: SqlClient;
const sessions: string[] = [];

beforeAll(async () => {
  sql = await createPostgresSqlClient(PG_URL);
  await ensureEventLogSchema(sql, "postgres");
});

afterAll(async () => {
  // Cleanup just the rows we created — leave the schema intact for repeat runs.
  for (const sid of sessions) {
    await sql.prepare(`DELETE FROM session_events WHERE session_id = ?`).bind(sid).run();
    await sql.prepare(`DELETE FROM session_streams WHERE session_id = ?`).bind(sid).run();
  }
});

describe("SqlEventLog on Postgres", () => {
  it("appendAsync + getEventsAsync round-trip", async () => {
    const sid = uniqSid("evlog");
    sessions.push(sid);
    const log = new SqlEventLog(sql, sid, () => {});
    await log.appendAsync({ type: "user.message", content: [{ type: "text", text: "hi" }] } as SessionEvent);
    await log.appendAsync({ type: "agent.message", content: [{ type: "text", text: "hello" }] } as SessionEvent);
    const events = await log.getEventsAsync();
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("user.message");
    expect(events[1]?.type).toBe("agent.message");
    // seq is per-session and starts at 1.
    expect((events[0] as { seq?: number }).seq).toBe(1);
    expect((events[1] as { seq?: number }).seq).toBe(2);
  });

  it("getEventsAsync(afterSeq) filters", async () => {
    const sid = uniqSid("evlog-after");
    sessions.push(sid);
    const log = new SqlEventLog(sql, sid, () => {});
    for (let i = 0; i < 3; i++) {
      await log.appendAsync({ type: "agent.message", content: [{ type: "text", text: `n${i}` }] } as SessionEvent);
    }
    const tail = await log.getEventsAsync(1);
    expect(tail.map((e) => (e as { seq?: number }).seq)).toEqual([2, 3]);
  });
});

describe("SqlStreamRepo on Postgres", () => {
  it("start + appendChunk (jsonb path) + finalize", async () => {
    const sid = uniqSid("stream");
    sessions.push(sid);
    const streams = new SqlStreamRepo(sql, sid, "postgres");
    const mid = "msg_test_001";
    await streams.start(mid, Date.now());
    // Idempotent re-start should be a no-op (ON CONFLICT DO NOTHING).
    await streams.start(mid, Date.now());
    await streams.appendChunk(mid, "Hello, ");
    await streams.appendChunk(mid, "world!");
    const row = await streams.get(mid);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("streaming");
    expect(row!.chunks).toEqual(["Hello, ", "world!"]);
    await streams.finalize(mid, "completed");
    const after = await streams.get(mid);
    expect(after!.status).toBe("completed");
  });
});

describe("PgEventStreamHub fanout (two hubs, same PG)", () => {
  it("replica A publish reaches replica B's local writer", async () => {
    const sid = uniqSid("fanout");
    sessions.push(sid);

    const fetchEventsAfter = (s: string, after: number) =>
      new SqlEventLog(sql, s, () => {}).getEventsAsync(after);

    const hubA = await PgEventStreamHub.create({ dsn: PG_URL, fetchEventsAfter });
    const hubB = await PgEventStreamHub.create({ dsn: PG_URL, fetchEventsAfter });
    try {
      const received: SessionEvent[] = [];
      const writer: EventWriter = {
        closed: false,
        write(ev) { received.push(ev as SessionEvent); },
        close() { this.closed = true; },
      };
      hubB.attach(sid, writer);

      // Persist + publish from A. The event must show up via the SQL
      // log so hub B can fetch it on NOTIFY (NOTIFY payload alone
      // doesn't carry the event body).
      const log = new SqlEventLog(sql, sid, () => {});
      await log.appendAsync({ type: "agent.message", content: [{ type: "text", text: "from A" }] } as SessionEvent);
      const stored = await log.getEventsAsync();
      const last = stored[stored.length - 1]!;
      const t0 = Date.now();
      hubA.publish(sid, last);

      await waitFor(() => received.length > 0, 2000);
      const dt = Date.now() - t0;
      expect(received).toHaveLength(1);
      expect((received[0] as { type?: string }).type).toBe("agent.message");
      // Local LISTEN/NOTIFY round-trips comfortably under 200ms; we
      // assert <1s as a sanity bound that accommodates loaded CI.
      expect(dt).toBeLessThan(1000);
    } finally {
      await hubA.stop();
      await hubB.stop();
    }
  });
});

function uniqSid(prefix: string): string {
  return `sess_test_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
}
