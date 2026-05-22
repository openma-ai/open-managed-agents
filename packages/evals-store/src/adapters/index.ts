// Adapter wiring. Both Cloudflare (D1) and Node (any OmaDb)
// deployment factories live here behind a single SqlEvalRunRepo class.

export { SqlEvalRunRepo } from "./sql-eval-run-repo";

import { drizzle } from "drizzle-orm/d1";
import { SqlEvalRunRepo } from "./sql-eval-run-repo";
import type { OmaDb } from "@open-managed-agents/db-schema";
import type { Logger } from "../ports";
import { EvalRunService } from "../service";

export function createCfEvalRunService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): EvalRunService {
  const drz = drizzle(deps.db);
  return new EvalRunService({
    repo: new SqlEvalRunRepo(drz),
    logger: opts?.logger,
  });
}

export function createSqliteEvalRunService(
  deps: { db: OmaDb },
  opts?: { logger?: Logger },
): EvalRunService {
  return new EvalRunService({
    repo: new SqlEvalRunRepo(deps.db),
    logger: opts?.logger,
  });
}
