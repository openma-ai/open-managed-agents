// Adapter wiring. Both Cloudflare (D1) and Node (any OmaDb)
// deployment factories live here behind a single SqlFileRepo class.

export { SqlFileRepo } from "./sql-file-repo";

import { drizzle } from "drizzle-orm/d1";
import { SqlFileRepo } from "./sql-file-repo";
import type { OmaDb } from "@open-managed-agents/db-schema";
import type { Logger } from "../ports";
import { FileService } from "../service";

export function createCfFileService(
  deps: { db: D1Database },
  opts?: { logger?: Logger },
): FileService {
  const drz = drizzle(deps.db);
  return new FileService({
    repo: new SqlFileRepo(drz),
    logger: opts?.logger,
  });
}

export function createSqliteFileService(
  deps: { db: OmaDb },
  opts?: { logger?: Logger },
): FileService {
  return new FileService({
    repo: new SqlFileRepo(deps.db),
    logger: opts?.logger,
  });
}
