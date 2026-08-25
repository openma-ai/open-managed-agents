// Feishu ops tables — SQLite schema-behavior + migration tests.
//
// Two suites over the SAME migration:
//
//   1. foreign_keys = ON  — proves the schema DECLARATIONS are correct (FKs,
//      CHECKs, composite UNIQUE all enforce) and the migration is idempotent.
//      This is the schema-correctness contract.
//
//   2. foreign_keys = OFF — the prod shape (main-node runs FK=OFF to match D1;
//      see apps/main-node/src/index.ts:184). The migration's hand-written
//      enforcement triggers must keep criteria ①-⑦⑨-⑰ holding under FK=OFF.
//      This is the blocker-1 contract: integrity survives the prod pragma.
//
// Both suites get a fresh on-disk temp DB (bootstrapTestDb → mkdtemp), so they
// are fully isolated; runId is cosmetic here but kept uniform with the PG test.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  bootstrapTestDb,
  type TestDb,
} from "./_helpers/bootstrap-test-db.js";
import { describeFeishuTablesCriteria } from "./_helpers/feishu-tables-criteria.js";

const migrationsFolder = fileURLToPath(
  new URL("../migrations-sqlite", import.meta.url),
);

let testDb: TestDb | undefined; // FK = ON
let testDbOff: TestDb | undefined; // FK = OFF (prod shape)

beforeAll(async () => {
  testDb = await bootstrapTestDb({ foreignKeys: true });
  testDbOff = await bootstrapTestDb({ foreignKeys: false });
});

afterAll(() => {
  testDb?.cleanup();
  testDbOff?.cleanup();
});

describe("feishu ops tables @ sqlite (foreign_keys = ON — schema correctness)", () => {
  describeFeishuTablesCriteria(() => testDb!.sql, randomUUID());

  it("⑧ migration is idempotent and lands all four tables + constraints + triggers", async () => {
    // Re-running migrate must be a no-op (drizzle tracks via
    // __drizzle_migrations) — no error, no duplicate-table blow-up.
    expect(() => migrate(testDb!.drz, { migrationsFolder })).not.toThrow();

    const tables = await testDb!.sql
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
          ('session_threads','group_events','feishu_message_events','memory_confirmations')`,
      )
      .all<{ name: string }>();
    const names = (tables.results ?? []).map((r) => r.name).sort();
    expect(names).toEqual([
      "feishu_message_events",
      "group_events",
      "memory_confirmations",
      "session_threads",
    ]);

    // CHECK constraints + composite FK land inside the CREATE TABLE DDL
    // (SQLite double-quotes constraint names, backtick-quotes identifiers).
    const ddlRow = await testDb!.sql
      .prepare(
        `SELECT sql AS s FROM sqlite_master WHERE type = 'table' AND name = 'memory_confirmations'`,
      )
      .first<{ s: string }>();
    const ddl = ddlRow?.s ?? "";
    for (const fragment of [
      'CONSTRAINT "ck_memory_confirmations_status"',
      'CONSTRAINT "ck_memory_confirmations_confirmed_fields"',
      "REFERENCES `group_events`",
    ]) {
      expect(ddl, `memory_confirmations DDL must contain ${fragment}`).toContain(
        fragment,
      );
    }

    // The composite UNIQUE is emitted as a separate UNIQUE INDEX on SQLite;
    // verify it lands as its own sqlite_master row (it's the FK target).
    const uniqueIdx = await testDb!.sql
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_memory_confirmations_session_tool'`,
      )
      .first<{ name: string }>();
    expect(uniqueIdx?.name).toBe("uq_memory_confirmations_session_tool");
    const groupUniqueIdx = await testDb!.sql
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'uq_group_events_tenant_event_group'`,
      )
      .first<{ name: string }>();
    expect(groupUniqueIdx?.name).toBe("uq_group_events_tenant_event_group");

    // Enforcement triggers landed — the complete declarative-FK mirror
    // (blocker 1): child INSERT + UPDATE existence, parent DELETE
    // (CASCADE / SET NULL / NO ACTION), parent UPDATE (NO ACTION), and the
    // self-ref cascade.
    const triggers = await testDb!.sql
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_fk%' ORDER BY name`,
      )
      .all<{ name: string }>();
    const triggerNames = (triggers.results ?? []).map((r) => r.name);
    expect(triggerNames).toEqual([
      "trg_fkd_gev_refs",
      "trg_fkd_session_gev",
      "trg_fkd_session_sthr",
      "trg_fkd_sthr_parent",
      "trg_fki_fme_group",
      "trg_fki_gev_supervisor",
      "trg_fki_mc_group",
      "trg_fki_sthr_parent",
      "trg_fki_sthr_session",
      "trg_fku_fme_group",
      "trg_fku_gev_refs",
      "trg_fku_gev_supervisor",
      "trg_fku_mc_group",
      "trg_fku_session_id",
      "trg_fku_sthr_parent",
      "trg_fku_sthr_pk",
      "trg_fku_sthr_session",
    ]);
  });
});

describe("feishu ops tables @ sqlite (foreign_keys = OFF — prod shape, triggers enforce)", () => {
  // Under FK=OFF the FOREIGN KEY clauses are inert; the migration's triggers
  // must keep ①-⑦⑨-⑰ holding. If any criterion flips here, a trigger is missing
  // or wrong. (Criteria ⑧ — migration idempotency — is covered above.)
  describeFeishuTablesCriteria(() => testDbOff!.sql, randomUUID());

  it("prod pragma is actually OFF in this suite (guard against a false-green)", async () => {
    const row = await testDbOff!.sql
      .prepare(`PRAGMA foreign_keys`)
      .first<{ foreign_keys: number }>();
    expect(row?.foreign_keys, "this suite must run with FK=OFF").toBe(0);
  });
});
