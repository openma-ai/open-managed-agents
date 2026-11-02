// Postgres NodeDatabase: postgres.js for the control plane and Drizzle, and
// a node-postgres pool for Better Auth (its Kysely dialect takes a pg Pool).

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import pg from "pg";
import postgres from "postgres";

import type { OmaDb } from "@open-managed-agents/db-schema";
import type { NodeDatabase } from "@open-managed-agents/node-database";
import { createPostgresSqlClient } from "@open-managed-agents/sql-client";

export interface PostgresDatabaseOptions {
  /** postgres:// connection string. */
  url: string;
}

export async function openPostgresDatabase(options: PostgresDatabaseOptions): Promise<NodeDatabase> {
  const { url } = options;
  const sql = await createPostgresSqlClient(url);
  const db = drizzle(postgres(url));
  const u = new URL(url);
  return {
    dialect: "postgres",
    sql,
    drizzle: db as unknown as OmaDb<Record<string, unknown>>,
    description: `postgres ${u.hostname}:${u.port || 5432}${u.pathname}`,
    applyMigrations: async (migrationsFolder) => {
      await migrate(db, { migrationsFolder });
    },
    openAuthDatabase: async () => {
      const pool = new pg.Pool({ connectionString: url });
      return {
        database: pool,
        sql,
        stop: async () => {
          await pool.end();
        },
      };
    },
  };
}
