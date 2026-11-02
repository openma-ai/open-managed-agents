// @ts-nocheck
//
// Integration tests for the single-table queued-input lifecycle.
// Reaches into a live SessionDO via runInDurableObject so the schema
// migration (ALTER TABLE ADD COLUMN + pending_events copy/drop) runs
// against real workerd SQLite, not a test-local mock.
//
// Coverage:
//   1. ensureSchema migrates v1 → v2 (adds processed_at/cancelled_at/
//      session_thread_id/enqueued_at, backfills legacy rows as processed).
//   2. ensureSchema copies legacy pending_events rows into events with
//      processed_at NULL (same event id) and drops the old table.
//   3. CfDoEventLog.append stamps processed_at; getEvents returns history.
//   4. enqueueQueueInput writes processed_at NULL in the same events table,
//      idempotent by id; peek/list/threads see it; getEvents excludes it.
//   5. stampProcessed promotes the SAME row/id (column + JSON), no second id.
//   6. cancelQueueForThread / cancelQueueByEventId never promote.
//   7. eventsToMessages skips cancelled rows when re-read via getEvents.

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import {
  CfDoEventLog,
  ensureSchema as ensureEventLogSchema,
} from "@open-managed-agents/event-log/cf-do";
import { eventsToMessages } from "../../apps/agent/src/runtime/history";

function stamp(e: any): void {
  if (!e.id) e.id = `sevt_${Math.random().toString(36).slice(2, 14)}`;
  if (!e.processed_at) e.processed_at = new Date().toISOString();
}

function freshDoStub(idHint: string) {
  const id = `${idHint}_${Math.random().toString(36).slice(2, 10)}`;
  return env.SESSION_DO.get(env.SESSION_DO.idFromName(id));
}

function queuedMessage(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "user.message",
    id: `sevt_${Math.random().toString(36).slice(2, 14)}`,
    content: [{ type: "text", text }],
    ...extra,
  } as any;
}

describe("event-log queued-input lifecycle", () => {
  it("ensureSchema migrates legacy events table (v1 → v2)", async () => {
    const stub = freshDoStub("pending_migration");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      // Drop fresh schema, recreate v1-only (no new columns) + seed
      // legacy rows. This simulates an existing prod DO that has the
      // old schema before the deploy.
      sql.exec(`DROP TABLE IF EXISTS events`);
      sql.exec(`
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          ts INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
        )
      `);
      sql.exec(
        `INSERT INTO events (type, data) VALUES (?, ?)`,
        "user.message",
        '{"type":"user.message","content":[{"type":"text","text":"old1"}]}',
      );
      sql.exec(
        `INSERT INTO events (type, data) VALUES (?, ?)`,
        "agent.message",
        '{"type":"agent.message","content":[{"type":"text","text":"reply1"}]}',
      );
      // Now run the new ensureSchema — must add columns + backfill.
      ensureEventLogSchema(sql);

      const cols: string[] = [];
      for (const row of sql.exec(`PRAGMA table_info(events)`)) {
        cols.push(row.name as string);
      }
      expect(cols).toEqual(
        expect.arrayContaining([
          "processed_at",
          "cancelled_at",
          "session_thread_id",
          "enqueued_at",
        ]),
      );

      // Legacy rows: processed_at should be filled (= ts) so the queued
      // partial index never picks them up; session_thread_id =
      // 'sthr_primary'.
      const rows: any[] = [];
      for (const row of sql.exec(
        `SELECT seq, type, processed_at, cancelled_at, session_thread_id FROM events ORDER BY seq`,
      )) {
        rows.push(row);
      }
      expect(rows).toHaveLength(2);
      expect(rows[0].processed_at).not.toBeNull();
      expect(rows[1].processed_at).not.toBeNull();
      expect(rows[0].cancelled_at).toBeNull();
      expect(rows[0].session_thread_id).toBe("sthr_primary");
      expect(rows[1].session_thread_id).toBe("sthr_primary");
    });
  });

  it("ensureSchema copies legacy pending_events into events and drops the table", async () => {
    const stub = freshDoStub("pending_takeover");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      sql.exec(`DROP TABLE IF EXISTS events`);
      sql.exec(`DROP TABLE IF EXISTS pending_events`);
      // Old dual-table shape with a pre-existing processed event + two
      // queued rows (one active, one cancelled).
      sql.exec(`
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          ts INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
          processed_at INTEGER,
          cancelled_at INTEGER,
          session_thread_id TEXT
        )
      `);
      sql.exec(
        `INSERT INTO events (type, data, processed_at, session_thread_id) VALUES (?, ?, ?, 'sthr_primary')`,
        "agent.message",
        '{"type":"agent.message","id":"ev_already","content":[{"type":"text","text":"done"}]}',
        Date.now(),
      );
      sql.exec(`
        CREATE TABLE pending_events (
          pending_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          enqueued_at INTEGER NOT NULL,
          session_thread_id TEXT NOT NULL,
          type TEXT NOT NULL,
          event_id TEXT NOT NULL,
          cancelled_at INTEGER,
          data TEXT NOT NULL
        )
      `);
      sql.exec(
        `INSERT INTO pending_events (enqueued_at, session_thread_id, type, event_id, cancelled_at, data)
         VALUES (?, 'sthr_primary', 'user.message', 'ev_queue1', NULL, ?)`,
        Date.now() - 1000,
        JSON.stringify(queuedMessage("queued one", { id: "ev_queue1" })),
      );
      sql.exec(
        `INSERT INTO pending_events (enqueued_at, session_thread_id, type, event_id, cancelled_at, data)
         VALUES (?, 'sthr_primary', 'user.message', 'ev_queue2', ?, ?)`,
        Date.now() - 900,
        Date.now() - 500,
        JSON.stringify(queuedMessage("cancelled two", { id: "ev_queue2" })),
      );

      ensureEventLogSchema(sql);

      // Table + indexes are gone.
      let pendingTable: string | null = null;
      for (const row of sql.exec(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_events'`,
      )) pendingTable = row.name as string;
      expect(pendingTable).toBeNull();

      const queued: any[] = [];
      for (const row of sql.exec(
        `SELECT seq, data, processed_at, cancelled_at, enqueued_at
           FROM events WHERE processed_at IS NULL ORDER BY seq`,
      )) queued.push(row);
      expect(queued).toHaveLength(2);
      expect(JSON.parse(queued[0].data).content[0].text).toBe("queued one");
      expect(queued[0].processed_at).toBeNull();
      expect(queued[0].cancelled_at).toBeNull();
      expect(queued[0].enqueued_at).not.toBeNull();
      expect(JSON.parse(queued[1].data).content[0].text).toBe("cancelled two");
      expect(queued[1].cancelled_at).not.toBeNull();

      // The already-processed event was not duplicated.
      let processedCount = 0;
      for (const row of sql.exec(
        `SELECT 1 FROM events WHERE processed_at IS NOT NULL`,
      )) processedCount += 1;
      expect(processedCount).toBe(1);
    });
  });

  it("append stamps normal events; getEvents is history only", async () => {
    const stub = freshDoStub("pending_append");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const log = new CfDoEventLog(sql, stamp);

      log.append({ type: "user.message", content: [{ type: "text", text: "hi" }] } as any);
      log.append({ type: "agent.message", content: [{ type: "text", text: "yo" }] } as any);

      const rows: any[] = [];
      for (const row of sql.exec(
        `SELECT type, processed_at FROM events ORDER BY seq`,
      )) rows.push(row);
      expect(rows).toHaveLength(2);
      expect(rows[0].type).toBe("user.message");
      expect(rows[0].processed_at).not.toBeNull();
      expect(rows[1].type).toBe("agent.message");
      expect(rows[1].processed_at).not.toBeNull();

      expect(log.getEvents()).toHaveLength(2);
      expect(log.getLastEventSeq("agent.message")).toBe(2);
    });
  });

  it("enqueueQueueInput writes null-processed rows, idempotent by id", async () => {
    const stub = freshDoStub("pending_lookup");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const log = new CfDoEventLog(sql, stamp);

      // Five on primary, two on a sub-agent thread.
      for (let i = 1; i <= 5; i++) {
        expect(log.enqueueQueueInput(queuedMessage(`primary ${i}`))).toBe(true);
      }
      for (let i = 1; i <= 2; i++) {
        expect(
          log.enqueueQueueInput(
            queuedMessage(`sub ${i}`, { session_thread_id: "sthr_subagentA" }),
          ),
        ).toBe(true);
      }

      // Idempotent by event id.
      const first = log.peekQueueInput("sthr_primary")!;
      const firstEvent = JSON.parse(first.data);
      expect(log.enqueueQueueInput({ ...firstEvent })).toBe(false);
      expect(log.listQueue("sthr_primary")).toHaveLength(5);

      // FIFO within a thread; rows are not history yet.
      expect(JSON.parse(first.data).content[0].text).toBe("primary 1");
      const p1 = log.listQueue("sthr_primary")[1];
      expect(JSON.parse(p1.data).content[0].text).toBe("primary 2");
      const sub0 = log.peekQueueInput("sthr_subagentA")!;
      expect(JSON.parse(sub0.data).content[0].text).toBe("sub 1");

      expect(log.listQueue("sthr_primary")).toHaveLength(5);
      expect(log.listQueue("sthr_subagentA")).toHaveLength(2);
      expect(log.threadsWithQueueInputs().sort()).toEqual([
        "sthr_primary",
        "sthr_subagentA",
      ]);
      // Raw getEvents keeps queued rows (marked _queued) so list/replay
      // can show them; the LLM projection must still skip them.
      const raw = log.getEvents();
      expect(raw).toHaveLength(7);
      expect(raw.every((e: any) => e._queued === true)).toBe(true);
      expect(eventsToMessages(raw)).toHaveLength(0);
      expect(log.getLastEventSeq("user.message")).toBe(-1);
    });
  });

  it("stampProcessed promotes the same events row/id", async () => {
    const stub = freshDoStub("pending_promote");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const log = new CfDoEventLog(sql, stamp);

      const event = queuedMessage("promote me");
      log.enqueueQueueInput(event);
      const row = log.peekQueueInput("sthr_primary")!;
      expect(row.event_id).toBe(event.id);

      const processedAt = Date.now();
      log.stampProcessed(row.seq, processedAt);

      // Same row/id; column + JSON both stamped.
      const rows: any[] = [];
      for (const raw of sql.exec(
        `SELECT seq, data, processed_at FROM events`,
      )) rows.push(raw);
      expect(rows).toHaveLength(1);
      expect(rows[0].seq).toBe(row.seq);
      expect(rows[0].processed_at).toBe(processedAt);
      const json = JSON.parse(rows[0].data);
      expect(json.id).toBe(event.id);
      expect(json.processed_at).toBe(new Date(processedAt).toISOString());

      expect(log.peekQueueInput("sthr_primary")).toBeNull();
      const history = log.getEvents();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe(event.id);
      expect((history[0] as any).processed_at_ms).toBe(processedAt);
    });
  });

  it("cancelQueueForThread only cancels the target thread", async () => {
    const stub = freshDoStub("pending_interrupt");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const log = new CfDoEventLog(sql, stamp);

      for (let i = 1; i <= 3; i++) log.enqueueQueueInput(queuedMessage(`primary ${i}`));
      for (let i = 1; i <= 2; i++) {
        log.enqueueQueueInput(
          queuedMessage(`subX ${i}`, { session_thread_id: "sthr_X" }),
        );
      }

      const cancelTs = Date.now();
      const cancelled = log.cancelQueueForThread("sthr_primary", cancelTs);
      expect(cancelled).toHaveLength(3);

      expect(log.listQueue("sthr_primary")).toHaveLength(0);
      expect(log.listQueue("sthr_X")).toHaveLength(2);

      const all = log.listQueue("sthr_primary", true);
      expect(all).toHaveLength(3);
      expect(all[0].cancelled_at).toBe(cancelTs);
      expect(all[2].cancelled_at).toBe(cancelTs);
      // Cancelled rows stay in the log for audit but never reach the model.
      expect(eventsToMessages(log.getEvents())).toHaveLength(0);

      expect(log.listQueue("sthr_X")[0].cancelled_at).toBeNull();
    });
  });

  it("cancelQueueByEventId returns null once promoted", async () => {
    const stub = freshDoStub("pending_cancel_one");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const log = new CfDoEventLog(sql, stamp);

      const a = queuedMessage("a");
      const b = queuedMessage("b");
      log.enqueueQueueInput(a);
      log.enqueueQueueInput(b);

      const ts = Date.now();
      const cancelled = log.cancelQueueByEventId(a.id, ts)!;
      expect(cancelled.event_id).toBe(a.id);
      expect(cancelled.cancelled_at).toBe(ts);
      expect(log.cancelQueueByEventId(a.id, ts + 1)).toBeNull();

      const remaining = log.listQueue("sthr_primary");
      expect(remaining).toHaveLength(1);
      expect(remaining[0].event_id).toBe(b.id);
    });
  });

  it("getEvents projects cancelled_at_ms and eventsToMessages skips cancelled", async () => {
    const stub = freshDoStub("pending_project");
    await runInDurableObject(stub, async (_inst, state) => {
      const sql = state.storage.sql;
      ensureEventLogSchema(sql);
      const log = new CfDoEventLog(sql, stamp);

      log.append({ type: "user.message", content: [{ type: "text", text: "first" }] } as any);
      log.append({ type: "user.message", content: [{ type: "text", text: "queued" }] } as any);
      log.append({ type: "user.message", content: [{ type: "text", text: "queued2" }] } as any);
      log.append({ type: "agent.message", id: "m_1", content: [{ type: "text", text: "ok" }] } as any);

      // Mark seq=2 + seq=3 cancelled (simulating user.interrupt where
      // these rows were already promoted but should be skipped).
      const ts = Date.now();
      sql.exec(`UPDATE events SET cancelled_at = ? WHERE seq IN (2, 3)`, ts);

      const events = log.getEvents();
      expect(events).toHaveLength(4);
      expect((events[0] as any).cancelled_at_ms).toBeUndefined();
      expect((events[1] as any).cancelled_at_ms).toBe(ts);
      expect((events[2] as any).cancelled_at_ms).toBe(ts);
      expect((events[3] as any).cancelled_at_ms).toBeUndefined();

      // eventsToMessages should now skip the two cancelled.
      const msgs = eventsToMessages(events);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe("user");
      expect((msgs[0].content as any[])[0].text).toBe("first");
      expect(msgs[1].role).toBe("assistant");
    });
  });
});
