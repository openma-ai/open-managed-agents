// Two SqlPollingEventStreamHub instances sharing one SQL database stand in
// for two main-node replicas. Replica A executes the Session (appends and
// publishes locally); replica B only has SSE subscribers.

import { describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import type { SessionEvent } from "@open-managed-agents/shared";
import { SqlPollingEventStreamHub } from "../src/lib/sql-polling-event-stream-hub";
import type { EventWriter } from "../src/lib/event-stream-hub";

type Ev = SessionEvent & { seq?: number };

async function database(): Promise<SqlClient> {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await sql.exec(`CREATE TABLE session_events (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`);
  return sql;
}

async function append(sql: SqlClient, sessionId: string, text: string): Promise<Ev> {
  const row = await sql
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_events WHERE session_id = ?`)
    .bind(sessionId)
    .first<{ seq: number }>();
  const seq = row!.seq;
  const event = { type: "agent.message", content: [{ type: "text", text }] } as unknown as Ev;
  await sql
    .prepare(`INSERT INTO session_events (session_id, seq, type, data) VALUES (?, ?, ?, ?)`)
    .bind(sessionId, seq, event.type, JSON.stringify(event))
    .run();
  return { ...event, seq };
}

function recorder(): EventWriter & { seen: Ev[]; texts(): string[] } {
  const seen: Ev[] = [];
  return {
    closed: false,
    seen,
    write(event) {
      seen.push(event);
    },
    close() {
      this.closed = true;
    },
    texts() {
      return seen.map((e) =>
        e.seq === undefined
          ? `chunk`
          : `${e.seq}:${(e as unknown as { content: Array<{ text: string }> }).content[0]!.text}`,
      );
    },
  };
}

function manualHub(sql: SqlClient, extra: { rowsPerQuery?: number; sessionsPerQuery?: number } = {}) {
  let running = 0;
  const hub = new SqlPollingEventStreamHub({
    sql,
    ...extra,
    schedule: () => {
      running += 1;
      return { stop: () => { running -= 1; } };
    },
  });
  return { hub, timers: () => running };
}

describe("SqlPollingEventStreamHub", () => {
  it("delivers events appended on another replica, in order, from the attach cursor", async () => {
    const sql = await database();
    const a = manualHub(sql).hub;
    const b = manualHub(sql).hub;
    await append(sql, "s1", "history");

    const writer = recorder();
    b.attach("s1", writer, { afterSeq: 1 });
    a.publish("s1", await append(sql, "s1", "one"));
    a.publish("s1", await append(sql, "s1", "two"));
    expect(writer.seen).toHaveLength(0);

    await b.pollOnce();
    expect(writer.texts()).toEqual(["2:one", "3:two"]);
    await b.pollOnce();
    expect(writer.texts()).toEqual(["2:one", "3:two"]);
  });

  it("starts live-only at the current tail when attached without a cursor", async () => {
    const sql = await database();
    const b = manualHub(sql).hub;
    await append(sql, "s1", "old-1");
    await append(sql, "s1", "old-2");

    const writer = recorder();
    b.attach("s1", writer);
    await b.pollOnce();
    expect(writer.seen).toHaveLength(0);

    await append(sql, "s1", "new");
    await b.pollOnce();
    expect(writer.texts()).toEqual(["3:new"]);
  });

  it("delivers local publishes immediately and never duplicates them from SQL", async () => {
    const sql = await database();
    const { hub } = manualHub(sql);
    const writer = recorder();
    hub.attach("s1", writer, { afterSeq: 0 });

    hub.publish("s1", await append(sql, "s1", "one"));
    hub.publish("s1", { type: "agent.message_chunk" } as unknown as Ev);
    expect(writer.texts()).toEqual(["1:one", "chunk"]);

    await hub.pollOnce();
    expect(writer.texts()).toEqual(["1:one", "chunk"]);
  });

  it("holds a local event that would skip a remote gap until the poller fills it", async () => {
    const sql = await database();
    const { hub } = manualHub(sql);
    const writer = recorder();
    hub.attach("s1", writer, { afterSeq: 0 });

    await append(sql, "s1", "from-other-replica");
    hub.publish("s1", await append(sql, "s1", "local"));
    expect(writer.seen).toHaveLength(0);

    await hub.pollOnce();
    expect(writer.texts()).toEqual(["1:from-other-replica", "2:local"]);
  });

  it("keeps independent cursors per writer and batches several sessions", async () => {
    const sql = await database();
    const { hub } = manualHub(sql, { sessionsPerQuery: 1, rowsPerQuery: 2 });
    for (let i = 1; i <= 3; i += 1) await append(sql, "s1", `a${i}`);
    await append(sql, "s2", "b1");

    const early = recorder();
    const late = recorder();
    const other = recorder();
    hub.attach("s1", early, { afterSeq: 0 });
    hub.attach("s1", late, { afterSeq: 2 });
    hub.attach("s2", other, { afterSeq: 0 });

    await hub.pollOnce();
    await hub.pollOnce();
    expect(early.texts()).toEqual(["1:a1", "2:a2", "3:a3"]);
    expect(late.texts()).toEqual(["3:a3"]);
    expect(other.texts()).toEqual(["1:b1"]);
  });

  it("runs the poll timer only while there are subscribers", async () => {
    const sql = await database();
    const { hub, timers } = manualHub(sql);
    expect(timers()).toBe(0);
    const detach = hub.attach("s1", recorder(), { afterSeq: 0 });
    const detach2 = hub.attach("s2", recorder(), { afterSeq: 0 });
    expect(timers()).toBe(1);
    detach();
    expect(timers()).toBe(1);
    detach2();
    expect(timers()).toBe(0);

    hub.attach("s3", recorder(), { afterSeq: 0 });
    hub.closeSession("s3");
    expect(timers()).toBe(0);
  });
});
