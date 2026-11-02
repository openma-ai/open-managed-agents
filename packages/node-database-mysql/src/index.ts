// MySQL NodeDatabase over mysql2. One pool serves Drizzle and Better Auth;
// the SqlClient keeps its own connections.

import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

import type { OmaDb } from "@open-managed-agents/db-schema";
import { migrateNodeMysqlSchema } from "@open-managed-agents/db-schema/node-mysql";
import type { NodeDatabase } from "@open-managed-agents/node-database";
import { createMysql2SqlClient } from "@open-managed-agents/sql-client";

export interface MysqlDatabaseOptions {
  /** mysql:// connection string. */
  url: string;
}

export async function openMysqlDatabase(options: MysqlDatabaseOptions): Promise<NodeDatabase> {
  const { url } = options;
  const sql = await createMysql2SqlClient(url);
  const pool = mysql.createPool({
    uri: url,
    supportBigNumbers: true,
    bigNumberStrings: false,
    timezone: "Z",
  });
  const u = new URL(url);
  return {
    dialect: "mysql",
    sql,
    drizzle: drizzle(pool) as unknown as OmaDb<Record<string, unknown>>,
    description: `mysql ${u.hostname}:${u.port || 3306}${u.pathname}`,
    // MySQL runs the SQLite-dialect migration files through its own
    // translator rather than a Drizzle migrator.
    applyMigrations: (migrationsFolder) => migrateNodeMysqlSchema(sql, migrationsFolder),
    // The pool belongs to the database; stop() below ends it.
    openAuthDatabase: async () => ({ database: pool, sql }),
    stop: async () => {
      await pool.end();
      await sql.close();
    },
  };
}
