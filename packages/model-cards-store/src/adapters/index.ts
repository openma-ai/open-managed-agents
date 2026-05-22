// Adapter wiring. Both Cloudflare (D1) and Node (any OmaDb)
// deployment factories live here behind a single SqlModelCardRepo class.

export { SqlModelCardRepo } from "./sql-model-card-repo";

import { drizzle } from "drizzle-orm/d1";
import { SqlModelCardRepo } from "./sql-model-card-repo";
import type { OmaDb } from "@open-managed-agents/db-schema";
import type { Crypto, Logger } from "../ports";
import { ModelCardService } from "../service";

export function createCfModelCardService(
  deps: { db: D1Database },
  opts?: { logger?: Logger; crypto?: Crypto },
): ModelCardService {
  const drz = drizzle(deps.db);
  return new ModelCardService({
    repo: new SqlModelCardRepo(drz),
    logger: opts?.logger,
    crypto: opts?.crypto,
  });
}

export function createSqliteModelCardService(
  deps: { db: OmaDb },
  opts?: { logger?: Logger; crypto?: Crypto },
): ModelCardService {
  return new ModelCardService({
    repo: new SqlModelCardRepo(deps.db),
    logger: opts?.logger,
    crypto: opts?.crypto,
  });
}
