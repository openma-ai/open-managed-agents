// Adapter wiring. Both Cloudflare (D1) and Node (any OmaDb) deployment
// factories live here behind a single SqlSessionRepo class.

export { SqlSessionRepo } from "./sql-session-repo";

import { SqlSessionRepo } from "./sql-session-repo";
import { drizzle } from "drizzle-orm/d1";
import type { OmaDb } from "@open-managed-agents/db-schema";
import type { Logger } from "../ports";
import { SessionService } from "../service";

export function createCfSessionService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): SessionService {
  const drz = drizzle(deps.db);
  return new SessionService({
    repo: new SqlSessionRepo(drz),
    logger: opts?.logger,
  });
}

export function createSqliteSessionService(
  deps: { db: OmaDb },
  opts?: { logger?: Logger },
): SessionService {
  return new SessionService({
    repo: new SqlSessionRepo(deps.db),
    logger: opts?.logger,
  });
}
