// Adapter wiring. CF + SQLite factories share a single SqlVaultRepo class.

export { SqlVaultRepo } from "./sql-vault-repo";

import { drizzle } from "drizzle-orm/d1";
import * as cfAuthSchema from "@open-managed-agents/db-schema/cf-auth";
import type { OmaDb } from "@open-managed-agents/db-schema";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { SqlVaultRepo } from "./sql-vault-repo";
import type { Logger } from "../ports";
import { VaultService } from "../service";

/** CF deployment factory. */
export function createCfVaultService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): VaultService {
  const db = drizzle(deps.db, { schema: cfAuthSchema });
  return new VaultService({
    repo: new SqlVaultRepo(db),
    logger: opts?.logger,
  });
}

/**
 * Node deployment factory.
 *
 * The Phase 6 plan flips the signature from raw SqlClient to Drizzle
 * OmaDb. Composition root in apps constructs Drizzle from better-sqlite3
 * / postgres.js and passes it here. The legacy `{ client: SqlClient }`
 * shape is intentionally rejected with an explanatory throw.
 */
export function createSqliteVaultService(
  deps: { client: SqlClient } | { db: OmaDb },
  opts?: { logger?: Logger },
): VaultService {
  if ("db" in deps) {
    return new VaultService({
      repo: new SqlVaultRepo(deps.db),
      logger: opts?.logger,
    });
  }
  throw new Error(
    "createSqliteVaultService now requires { db: OmaDb }; see Phase 6 plan.",
  );
}
