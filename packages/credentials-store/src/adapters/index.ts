// Adapter wiring. CF + SQLite factories share a single SqlCredentialRepo class.

export { SqlCredentialRepo } from "./sql-credential-repo";

import { drizzle } from "drizzle-orm/d1";
import { SqlCredentialRepo } from "./sql-credential-repo";
import type { OmaDb } from "@open-managed-agents/db-schema";
import type { Crypto, Logger } from "../ports";
import { CredentialService } from "../service";

/** CF deployment factory. */
export function createCfCredentialService(
  deps: { db: D1Database },
  opts?: { logger?: Logger; crypto?: Crypto },
): CredentialService {
  const drz = drizzle(deps.db);
  return new CredentialService({
    repo: new SqlCredentialRepo(drz, { crypto: opts?.crypto }),
    logger: opts?.logger,
  });
}

/** Node deployment factory — accepts any OmaDb. */
export function createSqliteCredentialService(
  deps: { db: OmaDb },
  opts?: { logger?: Logger; crypto?: Crypto },
): CredentialService {
  return new CredentialService({
    repo: new SqlCredentialRepo(deps.db, { crypto: opts?.crypto }),
    logger: opts?.logger,
  });
}
