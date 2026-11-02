// SQLite NodeDatabase over better-sqlite3: one file for the control plane,
// and a second file for Better Auth.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type { OmaDb } from "@open-managed-agents/db-schema";
import type { NodeAuthDatabase, NodeDatabase } from "@open-managed-agents/node-database";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";

export interface SqliteDatabaseOptions {
  /** Database file; its directory is created if missing. */
  path: string;
}

export async function openSqliteDatabase(options: SqliteDatabaseOptions): Promise<NodeDatabase> {
  const { path } = options;
  mkdirSync(dirname(path), { recursive: true });
  const sql = await createBetterSqlite3SqlClient(path);
  const raw = new BetterSqlite3(path);
  // Match D1's runtime default — FK enforcement off. See packages/sql-client
  // for the rationale (publication-first install + a few other paths).
  raw.exec("PRAGMA foreign_keys = OFF");
  const db = drizzle(raw);
  return {
    dialect: "sqlite",
    sql,
    drizzle: db as unknown as OmaDb<Record<string, unknown>>,
    description: `sqlite ${path}`,
    applyMigrations: async (migrationsFolder) => {
      migrate(db, { migrationsFolder });
    },
    openAuthDatabase: async ({ sqlitePath }) => openSqliteAuthDatabase(sqlitePath),
  };
}

function openSqliteAuthDatabase(path: string): NodeAuthDatabase {
  mkdirSync(dirname(path), { recursive: true });
  const database = new BetterSqlite3(path);
  return {
    database,
    sql: execOnlySqlClient(database),
    stop: async () => {
      database.close();
    },
  };
}

/**
 * The Better Auth schema apply only calls exec(), so the auth file gets this
 * minimal SqlClient instead of a second full client.
 */
function execOnlySqlClient(db: BetterSqlite3.Database): SqlClient {
  return {
    exec: async (statement: string) => {
      db.exec(statement);
    },
    prepare: () => {
      throw new Error("The SQLite auth database client only supports exec()");
    },
    batch: async () => [],
  } as SqlClient;
}
