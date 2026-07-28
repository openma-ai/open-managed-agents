// Adapter wiring. Both Cloudflare (D1) and Node (any OmaDb)
// deployment factories live here behind a single SqlEnvironmentRepo class.

export { SqlEnvironmentRepo } from "./sql-environment-repo";

import { drizzle } from "drizzle-orm/d1";
import { SqlEnvironmentRepo } from "./sql-environment-repo";
import type { OmaDb } from "@open-managed-agents/db-schema";
import type { Logger } from "../ports";
import { EnvironmentService } from "../service";

export function createCfEnvironmentService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): EnvironmentService {
  const drz = drizzle(deps.db);
  return new EnvironmentService({
    repo: new SqlEnvironmentRepo(drz),
    logger: opts?.logger,
  });
}

/**
 * Node deployment factory. Caller passes any OmaDb
 * (Drizzle-wrapped better-sqlite3 / postgres-js / D1).
 */
export function createSqliteEnvironmentService(
  deps: { db: OmaDb },
  opts?: { logger?: Logger },
): EnvironmentService {
  return new EnvironmentService({
    repo: new SqlEnvironmentRepo(deps.db),
    logger: opts?.logger,
  });
}
