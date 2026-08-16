// Shared schema-behavior assertions for the four Feishu ops tables.
//
// Runs against any SqlClient (SQLite or PG — the PG adapter normalizes `?`
// to `$n`, so the same `?`-parameterized SQL works on both). Covers the
// behavior criteria the user signed off for task 1:
//
//   ① two sessions each carry sthr_primary (composite PK permits it)
//   ② session delete cascades session_threads clear
//   ③ session delete retains group_events with supervisor_session_id NULL
//   ④ memory_confirmations.source_session_id snapshot survives session delete
//   ⑤ cross-tenant AND cross-group message event + confirmation rejected
//      by the composite FK
//   ⑥ event_id=NULL dedup骨架 row insertable (MATCH SIMPLE skips FK)
//   ⑦ status='confirmed' missing confirmer fields rejected by CHECK
//   ⑨ self-ref: non-existent parent_thread_id rejected
//   ⑩ self-ref: cross-session parent_thread_id rejected (session-scoped)
//   ⑪ UPDATE group_events.supervisor_session_id → non-existent session rejected
//   ⑫ UPDATE session_threads.parent_thread_id → non-existent thread rejected
//   ⑬ DELETE of a referenced group_events rejected (ON DELETE NO ACTION)
//   ⑭ self-ref ON DELETE CASCADE: parent delete removes all descendants
//   ⑮ UPDATE of a referenced group_events identity rejected (ON UPDATE NO ACTION)
//   ⑯ UPDATE feishu_message_events tenant_id/group_id ONLY (event_id unchanged)
//      rejected — composite FK can't be bypassed by changing one tuple column
//   ⑰ UPDATE session_threads session_id ONLY (parent_thread_id unchanged)
//      rejected — no cross-session parent reference via UPDATE
//
// Criterion ⑧ (migration apply + repeat/idempotency + per-engine schema
// presence) is dialect-specific and lives in each engine's test file.
//
// `runId` scopes EVERY created id (sessions, events, tenants, groups,
// threads, confirmations) so PG cleanup can delete only this run's rows by
// `LIKE '${runId}:%'` and never touch real data (real session ids use a
// `sess-` prefix; a UUID prefix cannot collide). SQLite uses a fresh temp
// DB per run, so the prefix is cosmetic there but keeps the helper uniform.

import { it, expect } from "vitest";
import type { SqlClient } from "@open-managed-agents/sql-client";

const NOW = 1_700_000_000_000;

/** True if a promise rejects (FK / CHECK / UNIQUE violation). */
async function rejects(p: Promise<unknown>): Promise<boolean> {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
}

export function describeFeishuTablesCriteria(
  getSql: () => SqlClient,
  runId: string,
): void {
  const id = (s: string): string => `${runId}:${s}`;

  async function insertSession(
    sql: SqlClient,
    sid: string,
    tenant: string,
  ): Promise<void> {
    await sql
      .prepare(
        `INSERT INTO sessions (id, tenant_id, status, created_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(sid, tenant, "running", NOW)
      .run();
  }

  async function insertThread(
    sql: SqlClient,
    sid: string,
    tid: string,
    parent: string | null,
  ): Promise<void> {
    if (parent === null) {
      await sql
        .prepare(
          `INSERT INTO session_threads (id, session_id, agent_id, created_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(tid, sid, "agent-supervisor", NOW)
        .run();
    } else {
      await sql
        .prepare(
          `INSERT INTO session_threads (id, session_id, agent_id, parent_thread_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(tid, sid, "agent-expert", parent, NOW)
        .run();
    }
  }

  it("① two sessions each carry their own sthr_primary (composite PK)", async () => {
    const sql = getSql();
    const tenant = id("t1");
    const sA = id("sess-1-a");
    const sB = id("sess-1-b");
    const primary = id("sthr_primary");
    await insertSession(sql, sA, tenant);
    await insertSession(sql, sB, tenant);
    await insertThread(sql, sA, primary, null);
    await insertThread(sql, sB, primary, null);
    const row = await sql
      .prepare(
        `SELECT COUNT(*) AS c FROM session_threads WHERE id = ? AND session_id IN (?, ?)`,
      )
      .bind(primary, sA, sB)
      .first<{ c: number }>();
    expect(row?.c, "both sessions should have a sthr_primary row").toBe(2);
  });

  it("② session delete cascades session_threads clear (parent + child)", async () => {
    const sql = getSql();
    const sid = id("sess-2-casc");
    const primary = id("sthr_primary");
    const child = id("sthr-child-2");
    await insertSession(sql, sid, id("t2"));
    await insertThread(sql, sid, primary, null);
    await insertThread(sql, sid, child, primary);
    await sql.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sid).run();
    const row = await sql
      .prepare(`SELECT COUNT(*) AS c FROM session_threads WHERE session_id = ?`)
      .bind(sid)
      .first<{ c: number }>();
    expect(row?.c, "session_threads should be emptied by cascade").toBe(0);
  });

  it("③ session delete retains group_events with supervisor_session_id NULL", async () => {
    const sql = getSql();
    const sid = id("sess-3-setnull");
    const ev = id("ev-3");
    await insertSession(sql, sid, id("t3"));
    await sql
      .prepare(
        `INSERT INTO group_events (event_id, tenant_id, group_id, supervisor_session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(ev, id("t3"), id("g3"), sid, "discussing", NOW, NOW)
      .run();
    await sql.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sid).run();
    const row = await sql
      .prepare(
        `SELECT supervisor_session_id AS s FROM group_events WHERE event_id = ?`,
      )
      .bind(ev)
      .first<{ s: string | null }>();
    expect(row, "group_events row must survive session delete").toBeTruthy();
    expect(row?.s, "supervisor_session_id must be SET NULL").toBeNull();
  });

  it("④ memory_confirmations.source_session_id snapshot survives session delete", async () => {
    const sql = getSql();
    const sid = id("sess-4-snap");
    const ev = id("ev-4");
    await insertSession(sql, sid, id("t4"));
    await sql
      .prepare(
        `INSERT INTO group_events (event_id, tenant_id, group_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(ev, id("t4"), id("g4"), "pending", NOW, NOW)
      .run();
    await sql
      .prepare(
        `INSERT INTO memory_confirmations
          (confirmation_id, tenant_id, source_session_id, custom_tool_use_id,
           event_id, group_id, memory_store_id, memory_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id("conf-4"),
        id("t4"),
        sid,
        id("ctu-4"),
        ev,
        id("g4"),
        id("store-4"),
        "/p/4",
        "pending",
        NOW,
      )
      .run();
    await sql.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sid).run();
    const row = await sql
      .prepare(
        `SELECT source_session_id AS s FROM memory_confirmations WHERE confirmation_id = ?`,
      )
      .bind(id("conf-4"))
      .first<{ s: string }>();
    expect(
      row,
      "memory_confirmations row must survive session delete (no FK)",
    ).toBeTruthy();
    expect(row?.s, "source_session_id snapshot must be retained verbatim").toBe(
      sid,
    );
  });

  it("⑤ cross-tenant AND cross-group message event + confirmation rejected", async () => {
    const sql = getSql();
    const t = id("t5a");
    const tWrong = id("t5b");
    const g = id("g5");
    const gWrong = id("g5b");
    const ev = id("ev-5");
    // group exists only for (t5a, ev-5, g5).
    await sql
      .prepare(
        `INSERT INTO group_events (event_id, tenant_id, group_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(ev, t, g, "pending", NOW, NOW)
      .run();

    // cross-tenant message event → reject.
    expect(
      await rejects(
        sql
          .prepare(
            `INSERT INTO feishu_message_events (delivery_id, tenant_id, group_id, event_id, received_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(id("del-5-bad-tenant"), tWrong, g, ev, NOW)
          .run(),
      ),
      "cross-tenant message event must be rejected",
    ).toBe(true);

    // SAME tenant, WRONG group → reject (composite FK covers group too).
    expect(
      await rejects(
        sql
          .prepare(
            `INSERT INTO feishu_message_events (delivery_id, tenant_id, group_id, event_id, received_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(id("del-5-bad-group"), t, gWrong, ev, NOW)
          .run(),
      ),
      "same-tenant / wrong-group message event must be rejected",
    ).toBe(true);

    // matching tenant+group+event → accepted (sanity).
    await sql
      .prepare(
        `INSERT INTO feishu_message_events (delivery_id, tenant_id, group_id, event_id, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id("del-5-ok"), t, g, ev, NOW)
      .run();

    // cross-tenant confirmation → reject.
    expect(
      await rejects(
        sql
          .prepare(
            `INSERT INTO memory_confirmations
              (confirmation_id, tenant_id, source_session_id, custom_tool_use_id,
               event_id, group_id, memory_store_id, memory_path, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id("conf-5-bad-tenant"),
            tWrong,
            id("sess-5"),
            id("ctu-5"),
            ev,
            g,
            id("store-5"),
            "/p/5",
            "pending",
            NOW,
          )
          .run(),
      ),
      "cross-tenant confirmation must be rejected",
    ).toBe(true);

    // SAME tenant, WRONG group confirmation → reject.
    expect(
      await rejects(
        sql
          .prepare(
            `INSERT INTO memory_confirmations
              (confirmation_id, tenant_id, source_session_id, custom_tool_use_id,
               event_id, group_id, memory_store_id, memory_path, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id("conf-5-bad-group"),
            t,
            id("sess-5b"),
            id("ctu-5b"),
            ev,
            gWrong,
            id("store-5b"),
            "/p/5b",
            "pending",
            NOW,
          )
          .run(),
      ),
      "same-tenant / wrong-group confirmation must be rejected",
    ).toBe(true);
  });

  it("⑥ event_id=NULL dedup骨架 row is insertable (MATCH SIMPLE skips FK)", async () => {
    const sql = getSql();
    // No group_events row exists — none required while event_id is NULL.
    await sql
      .prepare(
        `INSERT INTO feishu_message_events (delivery_id, tenant_id, group_id, event_id, event_type, received_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id("del-6"), id("t6"), id("g6"), null, "im.message.receive_v1", NOW)
      .run();
    const row = await sql
      .prepare(
        `SELECT event_id AS e FROM feishu_message_events WHERE delivery_id = ?`,
      )
      .bind(id("del-6"))
      .first<{ e: string | null }>();
    expect(row?.e, "骨架 row should store NULL event_id").toBeNull();
  });

  it("⑦ status='confirmed' missing confirmer fields is rejected by CHECK", async () => {
    const sql = getSql();
    const ev = id("ev-7");
    await sql
      .prepare(
        `INSERT INTO group_events (event_id, tenant_id, group_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(ev, id("t7"), id("g7"), "pending", NOW, NOW)
      .run();

    const baseCols = `INSERT INTO memory_confirmations
        (confirmation_id, tenant_id, source_session_id, custom_tool_use_id,
         event_id, group_id, memory_store_id, memory_path, status,
         confirmer_type, confirmer_id, confirmed_at, created_at)`;

    // confirmed with NULL confirmer fields → CHECK rejects.
    expect(
      await rejects(
        sql
          .prepare(`${baseCols} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(
            id("conf-7-bad"),
            id("t7"),
            id("sess-7"),
            id("ctu-7"),
            ev,
            id("g7"),
            id("store-7"),
            "/p/7",
            "confirmed",
            null,
            null,
            null,
            NOW,
          )
          .run(),
      ),
      "confirmed without confirmer_type/id/confirmed_at must be rejected",
    ).toBe(true);

    // confirmed with all three confirmer fields → accepted.
    await sql
      .prepare(`${baseCols} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        id("conf-7-ok"),
        id("t7"),
        id("sess-7"),
        id("ctu-7b"),
        ev,
        id("g7"),
        id("store-7"),
        "/p/7",
        "confirmed",
        "user",
        id("user-7"),
        NOW,
        NOW,
      )
      .run();

    // pending with NULL confirmer fields → accepted.
    await sql
      .prepare(
        `INSERT INTO memory_confirmations
          (confirmation_id, tenant_id, source_session_id, custom_tool_use_id,
           event_id, group_id, memory_store_id, memory_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id("conf-7-pending"),
        id("t7"),
        id("sess-7"),
        id("ctu-7c"),
        ev,
        id("g7"),
        id("store-7"),
        "/p/7",
        "pending",
        NOW,
      )
      .run();
  });

  it("⑨ self-ref: a non-existent parent_thread_id is rejected", async () => {
    const sql = getSql();
    const sid = id("sess-9");
    await insertSession(sql, sid, id("t9"));
    // parent_thread_id points to a thread id that does not exist in this
    // session → composite self-ref FK (session_id, parent_thread_id) rejects.
    expect(
      await rejects(
        sql
          .prepare(
            `INSERT INTO session_threads (id, session_id, agent_id, parent_thread_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(id("sthr-9-ghost"), sid, "agent-expert", id("sthr-nonexistent"), NOW)
          .run(),
      ),
      "a thread referencing a non-existent parent must be rejected",
    ).toBe(true);
  });

  it("⑩ self-ref: a cross-session parent_thread_id is rejected (session-scoped)", async () => {
    const sql = getSql();
    const sA = id("sess-10a");
    const sB = id("sess-10b");
    const primaryA = id("sthr_primary_A");
    await insertSession(sql, sA, id("t10"));
    await insertSession(sql, sB, id("t10"));
    await insertThread(sql, sA, primaryA, null);
    // parent_thread_id = session A's primary, but this thread lives in
    // session B → (sB, primaryA) does not exist in session_threads → reject.
    expect(
      await rejects(
        sql
          .prepare(
            `INSERT INTO session_threads (id, session_id, agent_id, parent_thread_id, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(id("sthr-10-cross"), sB, "agent-expert", primaryA, NOW)
          .run(),
      ),
      "a thread whose parent lives in a different session must be rejected",
    ).toBe(true);
  });

  it("⑪ UPDATE group_events.supervisor_session_id → non-existent session is rejected", async () => {
    const sql = getSql();
    const sid = id("sess-11");
    const ev = id("ev-11");
    await insertSession(sql, sid, id("t11"));
    await sql
      .prepare(
        `INSERT INTO group_events (event_id, tenant_id, group_id, supervisor_session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(ev, id("t11"), id("g11"), sid, "pending", NOW, NOW)
      .run();
    expect(
      await rejects(
        sql
          .prepare(`UPDATE group_events SET supervisor_session_id = ? WHERE event_id = ?`)
          .bind(id("sess-ghost-11"), ev)
          .run(),
      ),
      "repointing supervisor_session_id to a non-existent session must be rejected",
    ).toBe(true);
  });

  it("⑫ UPDATE session_threads.parent_thread_id → non-existent thread is rejected", async () => {
    const sql = getSql();
    const sid = id("sess-12");
    const primary = id("sthr-12-primary");
    const child = id("sthr-12-child");
    await insertSession(sql, sid, id("t12"));
    await insertThread(sql, sid, primary, null);
    await insertThread(sql, sid, child, primary);
    expect(
      await rejects(
        sql
          .prepare(`UPDATE session_threads SET parent_thread_id = ? WHERE session_id = ? AND id = ?`)
          .bind(id("sthr-ghost-12"), sid, child)
          .run(),
      ),
      "repointing parent_thread_id to a non-existent thread must be rejected",
    ).toBe(true);
  });

  it("⑬ DELETE of a group_events still referenced is rejected (ON DELETE NO ACTION)", async () => {
    const sql = getSql();
    const t = id("t13");
    const g = id("g13");
    const ev = id("ev-13");
    await sql
      .prepare(
        `INSERT INTO group_events (event_id, tenant_id, group_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(ev, t, g, "pending", NOW, NOW)
      .run();
    await sql
      .prepare(
        `INSERT INTO feishu_message_events (delivery_id, tenant_id, group_id, event_id, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(id("del-13"), t, g, ev, NOW)
      .run();
    // Referenced → delete must be rejected (no orphan).
    expect(
      await rejects(sql.prepare(`DELETE FROM group_events WHERE event_id = ?`).bind(ev).run()),
      "deleting a group_events still referenced by feishu_message_events must be rejected",
    ).toBe(true);
    // Once the child row is gone → delete succeeds.
    await sql.prepare(`DELETE FROM feishu_message_events WHERE delivery_id = ?`).bind(id("del-13")).run();
    await sql.prepare(`DELETE FROM group_events WHERE event_id = ?`).bind(ev).run();
    const row = await sql
      .prepare(`SELECT COUNT(*) AS c FROM group_events WHERE event_id = ?`)
      .bind(ev)
      .first<{ c: number }>();
    expect(row?.c, "group_events must be deletable once no longer referenced").toBe(0);
  });

  it("⑭ self-ref ON DELETE CASCADE: deleting a parent thread removes all descendants", async () => {
    const sql = getSql();
    const sid = id("sess-14");
    const gp = id("sthr-14-gp");
    const parent = id("sthr-14-p");
    const child = id("sthr-14-c");
    await insertSession(sql, sid, id("t14"));
    await insertThread(sql, sid, gp, null);
    await insertThread(sql, sid, parent, gp);
    await insertThread(sql, sid, child, parent);
    // Delete the grandparent → parent + child must cascade away transitively.
    await sql
      .prepare(`DELETE FROM session_threads WHERE session_id = ? AND id = ?`)
      .bind(sid, gp)
      .run();
    const row = await sql
      .prepare(`SELECT COUNT(*) AS c FROM session_threads WHERE session_id = ? AND id IN (?, ?, ?)`)
      .bind(sid, gp, parent, child)
      .first<{ c: number }>();
    expect(row?.c, "grandparent + parent + child should all be cascade-deleted").toBe(0);
  });

  it("⑮ UPDATE of a referenced group_events identity is rejected (ON UPDATE NO ACTION)", async () => {
    const sql = getSql();
    const t = id("t15");
    const g = id("g15");
    const ev = id("ev-15");
    await sql
      .prepare(
        `INSERT INTO group_events (event_id, tenant_id, group_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(ev, t, g, "pending", NOW, NOW)
      .run();
    await sql
      .prepare(
        `INSERT INTO memory_confirmations
          (confirmation_id, tenant_id, source_session_id, custom_tool_use_id,
           event_id, group_id, memory_store_id, memory_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id("conf-15"), t, id("sess-15"), id("ctu-15"), ev, g, id("store-15"), "/p/15", "pending", NOW)
      .run();
    // Referenced identity UPDATE → rejected.
    expect(
      await rejects(
        sql.prepare(`UPDATE group_events SET event_id = ? WHERE event_id = ?`).bind(id("ev-15-new"), ev).run(),
      ),
      "updating a referenced group_events identity column must be rejected",
    ).toBe(true);
    // Updating a NON-identity column while referenced is fine.
    await sql.prepare(`UPDATE group_events SET status = ? WHERE event_id = ?`).bind("discussing", ev).run();
  });

  it("⑯ UPDATE feishu_message_events tenant_id/group_id only (event_id unchanged) is rejected", async () => {
    const sql = getSql();
    const t = id("t16");
    const g = id("g16");
    const ev = id("ev-16");
    const delivery = id("del-16");
    // group exists only for (t16, ev-16, g16).
    await sql
      .prepare(
        `INSERT INTO group_events (event_id, tenant_id, group_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(ev, t, g, "pending", NOW, NOW)
      .run();
    await sql
      .prepare(
        `INSERT INTO feishu_message_events (delivery_id, tenant_id, group_id, event_id, received_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(delivery, t, g, ev, NOW)
      .run();

    // tenant_id only → composite tuple (t16-wrong, ev-16, g16) has no parent
    // → reject, even though event_id (the old trigger's sole WHEN condition)
    // is unchanged.
    expect(
      await rejects(
        sql
          .prepare(`UPDATE feishu_message_events SET tenant_id = ? WHERE delivery_id = ?`)
          .bind(id("t16-wrong"), delivery)
          .run(),
      ),
      "changing only tenant_id must still be rejected by the composite FK",
    ).toBe(true);

    // group_id only → same bypass shape, must also be rejected.
    expect(
      await rejects(
        sql
          .prepare(`UPDATE feishu_message_events SET group_id = ? WHERE delivery_id = ?`)
          .bind(id("g16-wrong"), delivery)
          .run(),
      ),
      "changing only group_id must still be rejected by the composite FK",
    ).toBe(true);

    // Row untouched by the rejected updates (ABORT rolls back the statement).
    const row = await sql
      .prepare(`SELECT tenant_id AS t, group_id AS g FROM feishu_message_events WHERE delivery_id = ?`)
      .bind(delivery)
      .first<{ t: string; g: string }>();
    expect(row?.t, "tenant_id must be unchanged after rejected updates").toBe(t);
    expect(row?.g, "group_id must be unchanged after rejected updates").toBe(g);

    // Updating a NON-FK column on the same row is fine (trigger re-checks
    // the unchanged tuple and passes).
    await sql
      .prepare(`UPDATE feishu_message_events SET event_type = ? WHERE delivery_id = ?`)
      .bind("im.message.receive_v1", delivery)
      .run();
  });

  it("⑰ UPDATE session_threads session_id only (parent kept) is rejected — no cross-session parent", async () => {
    const sql = getSql();
    const sA = id("sess-17a");
    const sB = id("sess-17b");
    const root = id("sthr-17-root");
    const leaf = id("sthr-17-leaf");
    const mover = id("sthr-17-mover");
    await insertSession(sql, sA, id("t17"));
    await insertSession(sql, sB, id("t17"));
    await insertThread(sql, sA, root, null);
    await insertThread(sql, sA, leaf, root);
    await insertThread(sql, sA, mover, null); // childless root for the sanity move

    // Move ONLY the leaf's session_id to a valid other session. The parent
    // stays `root`, which lives in sA — so the new tuple (sB, root) has no
    // matching parent row and must be rejected even though parent_thread_id
    // (the old trigger's sole WHEN condition) is unchanged.
    expect(
      await rejects(
        sql
          .prepare(`UPDATE session_threads SET session_id = ? WHERE session_id = ? AND id = ?`)
          .bind(sB, sA, leaf)
          .run(),
      ),
      "moving a child thread alone to another session must be rejected (cross-session parent)",
    ).toBe(true);

    // Leaf stayed in sA (ABORT rolled back the statement).
    const row = await sql
      .prepare(`SELECT session_id AS s, parent_thread_id AS p FROM session_threads WHERE id = ?`)
      .bind(leaf)
      .first<{ s: string; p: string }>();
    expect(row?.s, "leaf must remain in its original session").toBe(sA);
    expect(row?.p, "leaf parent must be untouched").toBe(root);

    // Sanity: moving a childless root thread (parent NULL) to an existing
    // session IS allowed — the rejection above is about the parent tuple,
    // not session existence.
    await sql
      .prepare(`UPDATE session_threads SET session_id = ? WHERE session_id = ? AND id = ?`)
      .bind(sB, sA, mover)
      .run();
    const moved = await sql
      .prepare(`SELECT session_id AS s FROM session_threads WHERE id = ?`)
      .bind(mover)
      .first<{ s: string }>();
    expect(moved?.s, "a parentless thread may move to an existing session").toBe(sB);
  });
}
