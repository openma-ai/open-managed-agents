// Shared PG test bootstrap: run the consolidated Drizzle baseline (same
// `apps/main-node/migrations` the app applies via postgres-js) against the
// disposable DB owned by `test:integration:storage`, then return a SqlClient
// for assertions.
//
// PG enforces FKs unconditionally (no off-switch), so — unlike the SQLite
// harness — there is no foreignKeys option.
//
// SAFETY: bootstrapTestDbPg refuses any non-loopback DSN. Tests scope every id
// with a per-run UUID prefix (see feishu-tables-criteria.ts) and clean up only
// their own rows — no broad `LIKE 'sess-%'`.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { PostgresSqlClient } from "@open-managed-agents/sql-client/adapters/postgres";
import { fileURLToPath } from "node:url";
import { getStorageIntegrationConfig } from "../../../../test/storage-integration.js";

export interface PgTestDb {
  sql: SqlClient;
  /** Re-run the migrator; drizzle tracks applied steps so this is a no-op. */
  migrateAgain: () => Promise<void>;
  /** Close the single underlying postgres-js connection (gap C). */
  end: () => Promise<void>;
}

export const PG_URL = getStorageIntegrationConfig().postgres.feishuSchema;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Refuse anything but the loopback target allocated by Testcontainers.
 */
function assertTestDsn(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`Storage integration PostgreSQL URL is invalid: ${url}`);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing PG migration tests against non-loopback host '${host}'.`,
    );
  }
}

export async function bootstrapTestDbPg(): Promise<PgTestDb> {
  assertTestDsn(PG_URL);
  const migrationsFolder = fileURLToPath(
    new URL("../../migrations", import.meta.url),
  );

  // ONE owned postgres-js connection drives BOTH drizzle migrate AND the
  // assertion SqlClient. Owning it lets end() really close it (gap C) — the
  // public createPostgresSqlClient() factory hides its own pool with no
  // end(), so a harness built on it could not close anything and the pool
  // would leak until process exit.
  const conn = postgres(PG_URL, {
    max: 1,
    types: {
      // OID 20 = BIGINT (int8). Coerce to JS number — mirrors
      // createPostgresSqlClient so created_at / token counters read back as
      // numbers (ms timestamps sit well below 2^53).
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: number) => v.toString(),
        parse: (v: string) => Number(v),
      },
    },
  });
  const runMigrate = (): Promise<void> =>
    migrate(drizzle(conn), { migrationsFolder });
  await runMigrate();
  const sql = new PostgresSqlClient(
    conn as unknown as ConstructorParameters<typeof PostgresSqlClient>[0],
  );
  return {
    sql,
    migrateAgain: async () => {
      await runMigrate();
    },
    end: async () => {
      await conn.end({ timeout: 5 });
    },
  };
}
