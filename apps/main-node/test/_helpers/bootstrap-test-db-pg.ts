// Shared PG test bootstrap: run the consolidated Drizzle baseline (same
// `apps/main-node/migrations` the app applies via postgres-js) against the DB
// at PG_TEST_URL, then return a SqlClient for assertions.
//
// PG enforces FKs unconditionally (no off-switch), so — unlike the SQLite
// harness — there is no foreignKeys option.
//
// Skipped (PG_ENABLED = false) unless PG_TEST_URL is set. Run locally with:
//   docker run --rm -p 54329:5432 -e POSTGRES_USER=oma -e POSTGRES_PASSWORD=oma \
//     -e POSTGRES_DB=oma postgres:16-alpine
//   PG_TEST_URL=postgres://oma:oma@127.0.0.1:54329/oma pnpm --filter \
//     @open-managed-agents/main-node test feishu-tables.schema.pg
//
// SAFETY (blocker 3): bootstrapTestDbPg refuses any non-loopback DSN unless
// PG_TEST_ALLOW_REMOTE=1 is set, so a mis-pointed PG_TEST_URL can never reach a
// shared / remote / prod DB. Tests scope every id with a per-run UUID prefix
// (see feishu-tables-criteria.ts) and clean up only their own rows — no broad
// `LIKE 'sess-%'`.

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { PostgresSqlClient } from "@open-managed-agents/sql-client/adapters/postgres";
import { fileURLToPath } from "node:url";

export interface PgTestDb {
  sql: SqlClient;
  /** Re-run the migrator; drizzle tracks applied steps so this is a no-op. */
  migrateAgain: () => Promise<void>;
  /** Close the single underlying postgres-js connection (gap C). */
  end: () => Promise<void>;
}

export const PG_URL = process.env.PG_TEST_URL ?? "";
export const PG_ENABLED =
  PG_URL.startsWith("postgres://") || PG_URL.startsWith("postgresql://");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Refuse anything but a loopback target unless explicitly overridden. This is
 * the structural guard behind blocker 3: even if PG_TEST_URL is mis-set to a
 * shared/remote DB, the bootstrap aborts before migrating or deleting.
 */
function assertTestDsn(url: string): void {
  if (process.env.PG_TEST_ALLOW_REMOTE === "1") return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`PG_TEST_URL is not a valid URL: ${url}`);
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing PG migration tests against non-loopback host '${host}'. ` +
        `PG_TEST_URL must point at a dedicated LOCAL test DB, or set ` +
        `PG_TEST_ALLOW_REMOTE=1 to override this guard.`,
    );
  }
}

export async function bootstrapTestDbPg(): Promise<PgTestDb> {
  if (!PG_ENABLED) {
    throw new Error("PG_TEST_URL is not set");
  }
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
