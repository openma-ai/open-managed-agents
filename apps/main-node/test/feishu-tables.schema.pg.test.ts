// Feishu ops tables — PG schema-behavior + migration tests.
//
// Runs the consolidated PG baseline (the exact postgres-js migrator the app
// uses) against PG_TEST_URL. PG enforces FKs unconditionally, so it is the
// authoritative enforcer for self-host Postgres deployments.
//
// Skipped unless PG_TEST_URL is set. Run locally with:
//   docker run --rm -p 54329:5432 -e POSTGRES_USER=oma -e POSTGRES_PASSWORD=oma \
//     -e POSTGRES_DB=oma postgres:16-alpine
//   PG_TEST_URL=postgres://oma:oma@127.0.0.1:54329/oma pnpm --filter \
//     @open-managed-agents/main-node test feishu-tables.schema.pg
//
// SAFETY: bootstrapTestDbPg guards PG_TEST_URL to loopback (blocker 3). Every
// id this run creates is prefixed with `runId:` so afterAll deletes ONLY its
// own rows — no broad LIKE that could touch real data.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  bootstrapTestDbPg,
  PG_ENABLED,
  type PgTestDb,
} from "./_helpers/bootstrap-test-db-pg.js";
import { describeFeishuTablesCriteria } from "./_helpers/feishu-tables-criteria.js";

const d = PG_ENABLED ? describe : describe.skip;

// Per-run prefix. Every created id becomes `${runId}:...`, so cleanup is a
// single scoped `LIKE '${runId}:%'` per table and cannot collide with real
// data (real session ids are not UUID-prefixed) or other runs.
const runId = randomUUID();

let pg: PgTestDb | undefined;

beforeAll(async () => {
  if (!PG_ENABLED) return;
  pg = await bootstrapTestDbPg();
});

afterAll(async () => {
  if (!pg) return;
  const sql = pg.sql;
  const prefix = `${runId}:%`;
  // Children first (composite FKs are NO ACTION): confirmations →
  // message_events → group_events → session_threads → sessions. Each delete
  // is scoped to THIS run's prefix.
  //
  // Cleanup errors are NOT swallowed (P2): we run every delete to maximise
  // cleanup, capture the FIRST error, ALWAYS close the connection in finally,
  // then rethrow so a broken cleanup fails the suite instead of silently
  // leaving rows.
  const deletes = [
    `DELETE FROM memory_confirmations WHERE confirmation_id LIKE ?`,
    `DELETE FROM feishu_message_events WHERE delivery_id LIKE ?`,
    `DELETE FROM group_events WHERE event_id LIKE ?`,
    `DELETE FROM session_threads WHERE session_id LIKE ?`,
    `DELETE FROM sessions WHERE id LIKE ?`,
  ];
  let firstErr: unknown;
  try {
    for (const stmt of deletes) {
      try {
        await sql.prepare(stmt).bind(prefix).run();
      } catch (e) {
        if (firstErr === undefined) firstErr = e;
      }
    }
  } finally {
    await pg.end();
  }
  if (firstErr !== undefined) throw firstErr;
});

d("feishu ops tables @ postgres", () => {
  describeFeishuTablesCriteria(() => pg!.sql, runId);

  it("⑧ migration lands all four tables + constraints on PG and is idempotent", async () => {
    // Re-running the exact app migrator must be a no-op (drizzle tracks via
    // __drizzle_migrations) — gap B: proves repeat-execution, not rollback.
    await expect(pg!.migrateAgain()).resolves.toBeUndefined();

    const res = await pg!.sql
      .prepare(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name IN
            ('session_threads','group_events','feishu_message_events','memory_confirmations')`,
      )
      .all<{ table_name: string }>();
    const names = (res.results ?? []).map((r) => r.table_name).sort();
    expect(names).toEqual([
      "feishu_message_events",
      "group_events",
      "memory_confirmations",
      "session_threads",
    ]);

    // CHECK constraints registered in pg.
    const checks = await pg!.sql
      .prepare(
        `SELECT conname FROM pg_constraint
         WHERE connamespace = 'public'::regnamespace
           AND contype = 'c'
           AND conname IN ('ck_group_events_status',
                           'ck_memory_confirmations_status',
                           'ck_memory_confirmations_confirmer_type',
                           'ck_memory_confirmations_confirmed_fields')`,
      )
      .all<{ conname: string }>();
    const checkNames = (checks.results ?? []).map((r) => r.conname).sort();
    expect(checkNames).toEqual([
      "ck_group_events_status",
      "ck_memory_confirmations_confirmed_fields",
      "ck_memory_confirmations_confirmer_type",
      "ck_memory_confirmations_status",
    ]);

    // Composite UNIQUE on group_events (FK target) + composite FKs.
    const fks = await pg!.sql
      .prepare(
        `SELECT conname FROM pg_constraint
         WHERE connamespace = 'public'::regnamespace
           AND contype = 'f'
           AND conrelid = 'feishu_message_events'::regclass`,
      )
      .all<{ conname: string }>();
    expect((fks.results ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
