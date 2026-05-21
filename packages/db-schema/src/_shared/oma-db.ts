// Drizzle DB port — the dependency-inversion seam between adapter code
// and platform-specific Drizzle clients.
//
// **Why not expose SqlClient.raw and have adapters internally construct
// drizzle?** That's the wrong direction — adapters would depend on the
// concrete client driver (D1 vs Pool vs better-sqlite3). DIP says the
// adapter should depend on an ABSTRACTION; the composition root provides
// the concrete instance.
//
// **Why a union type instead of a structural interface?** Drizzle's
// query builder uses chained types whose return shape depends on the
// dialect (e.g. SQLite chains expose `.get()` / `.all()`; PG awaits
// directly). Defining a structural subset would discard most of
// Drizzle's type inference. The union lets each call site specialise
// when it matters and use helpers when it doesn't.
//
// Adapters import `type { OmaDb }` and accept it as constructor arg.
// Composition root (apps/main, apps/main-node, apps/agent boot paths
// or packages/services factory) constructs the matching client:
//
//   CF D1:           drizzle(env.AUTH_DB, { schema: cfAuthSchema })
//   Node-PG:         drizzle(postgresClient, { schema: nodePgSchema })
//   Node SQLite:     drizzle(betterSqlite3Db, { schema: cfAuthSchema })
//
// Because cf-auth/cf-integrations/cf-router/node-pg schemas have
// structurally-identical exports (port from Phase 2), passing any of
// them as the `schema` arg works — query references stay the same.

import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/**
 * The dependency-inversion port for adapters. Concrete instance is
 * constructed at the composition root.
 *
 * `<TSchema>` is the schema dictionary you passed to `drizzle()`. Most
 * adapters can get away with `OmaDb` (no schema generic) and rely on
 * the imported table refs for column-level type info.
 */
export type OmaDb<TSchema extends Record<string, unknown> = Record<string, never>> =
  | DrizzleD1Database<TSchema>
  | BetterSQLite3Database<TSchema>
  | PostgresJsDatabase<TSchema>;

/**
 * Discriminator for the dialect. Adapters that need to fork on dialect
 * (e.g. raw SQL escape hatches, json_extract vs ->>) compare against
 * this rather than instanceof checks. The composition root sets it.
 */
export type OmaDialect = "sqlite" | "pg";

/**
 * Convenience: a Drizzle DB plus its dialect tag. Not strictly needed
 * — most adapter code can ignore dialect since the query builder is
 * structurally compatible — but useful for the small fraction of code
 * that does need to fork.
 */
export interface OmaDbWithDialect<TSchema extends Record<string, unknown> = Record<string, never>> {
  readonly db: OmaDb<TSchema>;
  readonly dialect: OmaDialect;
}

// ──────────────────────────────────────────────────────────────────────
// Terminator helpers
// ──────────────────────────────────────────────────────────────────────
//
// Drizzle's PG and SQLite query builders share 95% of their fluent API
// (`.select().from().where(eq(...))`) but disagree on how to actually
// execute. SQLite requires an explicit `.get()` / `.all()` terminator;
// PG awaits the chain directly.
//
// Adapters write the chain once; these helpers run it correctly on
// either dialect by feature-detecting the terminator. No `as any`
// boundary in adapter code.

interface SqliteSelectChain<T> {
  get(): Promise<T | undefined>;
  all(): Promise<T[]>;
}

/**
 * Run a SELECT chain expecting at most one row. Returns the row or null.
 * Use for `.where(eq(t.id, id))` style lookups.
 */
export async function getOne<T>(query: PromiseLike<T[]> | SqliteSelectChain<T>): Promise<T | null> {
  if (typeof (query as SqliteSelectChain<T>).get === "function") {
    const r = await (query as SqliteSelectChain<T>).get();
    return r ?? null;
  }
  const rows = await (query as PromiseLike<T[]>);
  return rows[0] ?? null;
}

/**
 * Run a SELECT chain expecting any number of rows. Returns the rows.
 */
export async function getAll<T>(query: PromiseLike<T[]> | SqliteSelectChain<T>): Promise<T[]> {
  if (typeof (query as SqliteSelectChain<T>).all === "function") {
    return await (query as SqliteSelectChain<T>).all();
  }
  return await (query as PromiseLike<T[]>);
}

interface SqliteRunChain {
  run(): Promise<unknown>;
}

/**
 * Run a mutation chain (INSERT / UPDATE / DELETE) with no result.
 * SQLite needs `.run()`; PG just awaits.
 */
export async function runOnce(query: PromiseLike<unknown> | SqliteRunChain): Promise<void> {
  if (typeof (query as SqliteRunChain).run === "function") {
    await (query as SqliteRunChain).run();
    return;
  }
  await (query as PromiseLike<unknown>);
}

/**
 * Run a mutation chain that returns rows (e.g. `.returning()` on PG,
 * `INSERT ... RETURNING *` on SQLite via Drizzle). Returns the rows.
 */
export async function runReturning<T>(
  query: PromiseLike<T[]> | { returning(): SqliteSelectChain<T> },
): Promise<T[]> {
  // PG: just await the chain (it has .returning() pre-applied if needed).
  // SQLite: chain ends in .returning() which exposes .all().
  if (typeof (query as { returning: () => SqliteSelectChain<T> }).returning === "function") {
    return await (query as { returning: () => SqliteSelectChain<T> }).returning().all();
  }
  return await (query as PromiseLike<T[]>);
}
