// Shared test bootstrap: open an on-disk SQLite, apply the consolidated
// Drizzle baseline, return both an OmaDb (Drizzle) and a SqlClient view of
// the same DB.
//
// `:memory:` is per-connection in better-sqlite3; tests need on-disk so
// the migrator + the SqlClient opened afterward observe the same schema.

import {
  createBetterSqlite3SqlClient,
  type SqlClient,
} from "@open-managed-agents/sql-client";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { OmaDb } from "@open-managed-agents/db-schema";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestDb {
  sql: SqlClient;
  db: OmaDb;
  drz: BetterSQLite3Database;
  cleanup: () => void;
}

export interface BootstrapTestDbOptions {
  /**
   * Flip `PRAGMA foreign_keys = ON` on both the drizzle connection and the
   * SqlClient connection. Defaults to false (matches D1's runtime default —
   * see packages/sql-client/src/adapters/better-sqlite3.ts).
   *
   * Migration / cascade tests that need to assert FK enforcement (ON DELETE
   * CASCADE / SET NULL, composite FK rejection) pass true.
   */
  foreignKeys?: boolean;
}

export async function bootstrapTestDb(
  options: BootstrapTestDbOptions = {},
): Promise<TestDb> {
  const foreignKeys = options.foreignKeys ?? false;
  const pragma = `PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`;
  const tmpDir = mkdtempSync(join(tmpdir(), "oma-test-"));
  const dbPath = join(tmpDir, "test.db");
  const sqliteRaw = new BetterSqlite3(dbPath);
  sqliteRaw.exec(pragma);
  const drz = drizzle(sqliteRaw);
  const migrationsFolder = fileURLToPath(
    new URL("../../migrations-sqlite", import.meta.url),
  );
  migrate(drz, { migrationsFolder });
  const sql = await createBetterSqlite3SqlClient(dbPath);
  // createBetterSqlite3SqlClient hardcodes FK OFF at construction; flip it to
  // match the requested mode so the SqlClient connection enforces FKs too.
  await sql.exec(pragma);
  return {
    sql,
    db: drz as unknown as OmaDb,
    drz,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}
