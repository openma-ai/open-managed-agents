// Runtime-agnostic SQL client port.
//
// Goal: lift store-package SQL adapters off Cloudflare's D1Database and onto
// a uniform interface that any SQL backend (D1 / better-sqlite3 / postgres.js
// / etc.) can satisfy. The shape mirrors D1's binding API because every
// existing CF adapter uses that idiom directly:
//
//   db.prepare(sql).bind(...args).run()
//   db.prepare(sql).bind(...args).first<T>()
//   db.prepare(sql).bind(...args).all<T>()
//   db.batch([stmt1, stmt2, ...])
//
// Keeping the chain identical means existing D1-backed repo code (e.g.
// packages/agents-store/src/adapters/d1-agent-repo.ts) becomes runtime-
// agnostic with `D1Database` swapped for `SqlClient`. A self-host deployment
// then constructs `BetterSqlite3SqlClient(localDb)` and the same repo runs
// on Node + sqlite without further edits.
//
// Adapters: see ./adapters/cf-d1.ts (CF passthrough),
// ./adapters/better-sqlite3.ts, ./adapters/postgres.ts, and
// ./adapters/mysql2.ts (Node adapters lazy-import their drivers).

/**
 * Per-statement metadata returned by mutation execution. Mirrors D1Result.meta.
 *  - changes: rows affected by this statement.
 *  - last_row_id: AUTOINCREMENT id of the row inserted by this statement,
 *    if any. Always undefined for non-INSERT or no-AUTOINCREMENT inserts.
 */
export interface SqlExecMeta {
  changes: number;
  last_row_id?: number;
}

/**
 * SELECT result envelope. Mirrors D1Result<T> for `.all()`.
 */
export interface SqlSelectResult<T> {
  results?: T[];
  meta?: SqlExecMeta;
}

/**
 * Mutation result envelope. Mirrors D1Result for `.run()`.
 */
export interface SqlRunResult<T = unknown> {
  results?: T[];
  meta: SqlExecMeta;
  success?: boolean;
}

/**
 * A prepared+bindable statement. Construct via SqlClient.prepare(); then
 * call exactly one of run/first/all (or hand to client.batch). Reusing one
 * SqlStatement across multiple execute calls is undefined behaviour.
 */
export interface SqlStatement {
  /** Bind positional parameters. Returns the same statement for chaining. */
  bind(...params: unknown[]): SqlStatement;

  /** Execute as a mutation. Returns rowsAffected via meta.changes. */
  run<T = unknown>(): Promise<SqlRunResult<T>>;

  /** Execute as a SELECT returning a single row, or null. */
  first<T = unknown>(): Promise<T | null>;

  /** Execute as a SELECT returning all matched rows. */
  all<T = unknown>(): Promise<SqlSelectResult<T>>;
}

/** A short connection-bound scope. Statements become unusable when it closes. */
export interface SqlTransaction {
  prepare(sql: string): SqlStatement;
}

export interface SqlRowLockCapability {
  supported: boolean;
  engine: string;
  version: string;
  reason: string;
}

export interface SqlRowLockTransactions {
  /** Verify server version and transactional storage for all requested tables. */
  capability(tables: readonly string[]): Promise<SqlRowLockCapability>;
  /** READ COMMITTED; await every statement. Validation precedes COMMIT. No replay. */
  run<T>(body: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
}

/**
 * The port. self-host implementations live in adapters/.
 *
 * `batch` MUST execute the statements atomically (all succeed or all roll
 * back). Returned array is per-statement meta in the same order.
 */
export interface SqlClient {
  /** Absent on SQLite/D1: callers retain their atomic CAS implementation. */
  readonly rowLockTransactions?: SqlRowLockTransactions;
  prepare(sql: string): SqlStatement;
  batch<T = unknown>(stmts: SqlStatement[]): Promise<Array<SqlRunResult<T>>>;
  /** Node adapters validate before COMMIT; throwing rolls back every statement. */
  batchChecked?<T = unknown>(stmts: SqlStatement[], validate: (results: Array<SqlRunResult<T>>) => void): Promise<Array<SqlRunResult<T>>>;
  /** Execute raw DDL/migration SQL. No params, no result rows. */
  exec(sql: string): Promise<void>;
}
