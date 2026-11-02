// Contract for the Node control plane's database. A NodeDatabase is one open
// connection, plus the dialect-specific operations that need the driver:
// running Drizzle migrations and opening the database Better Auth uses.
//
// Adapter packages (node-database-sqlite, -postgres, -mysql) implement it and
// own the driver imports, so code written against this contract never loads
// a database driver itself.

import type { OmaDb } from "@open-managed-agents/db-schema";
import type { SqlClient } from "@open-managed-agents/sql-client";

export type NodeDialect = "postgres" | "mysql" | "sqlite";

export interface NodeDatabase {
  readonly dialect: NodeDialect;
  readonly sql: SqlClient;
  /** Drizzle handle over the same database; new-style adapters take this. */
  readonly drizzle: OmaDb<Record<string, unknown>>;
  /** Shown in /health and startup logs. Never includes credentials. */
  readonly description: string;
  /** Apply the Drizzle migrations in `migrationsFolder` with this dialect's migrator. */
  applyMigrations(migrationsFolder: string): Promise<void>;
  /**
   * Open the database Better Auth stores users and sessions in. Optional: a
   * caller-built NodeDatabase may omit it and supply its own auth component.
   */
  openAuthDatabase?(options: NodeAuthDatabaseOptions): Promise<NodeAuthDatabase>;
  stop?(): Promise<void>;
}

export interface NodeAuthDatabaseOptions {
  /**
   * File for Better Auth's tables when the main database is SQLite, which
   * keeps them in a separate file. Server databases share their connection
   * and ignore it.
   */
  sqlitePath: string;
}

export interface NodeAuthDatabase {
  /** Passed to Better Auth as `database`: a driver pool or connection. */
  readonly database: unknown;
  /** Runs the Better Auth schema DDL against the same database. */
  readonly sql: SqlClient;
  stop?(): Promise<void>;
}
