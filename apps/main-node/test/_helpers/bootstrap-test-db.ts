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

export async function bootstrapTestDb(): Promise<TestDb> {
  const tmpDir = mkdtempSync(join(tmpdir(), "oma-test-"));
  const dbPath = join(tmpDir, "test.db");
  const sqliteRaw = new BetterSqlite3(dbPath);
  // Match D1's default; see packages/sql-client/src/adapters/better-sqlite3.ts.
  sqliteRaw.exec("PRAGMA foreign_keys = OFF");
  const drz = drizzle(sqliteRaw);
  const migrationsFolder = fileURLToPath(
    new URL("../../migrations-sqlite", import.meta.url),
  );
  migrate(drz, { migrationsFolder });
  const sql = await createBetterSqlite3SqlClient(dbPath);
  return {
    sql,
    db: drz as unknown as OmaDb,
    drz,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}
