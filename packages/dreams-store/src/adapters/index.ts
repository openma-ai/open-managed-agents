// Adapter wiring for the dreams-store. CF (D1) and self-host (any SqlClient)
// share the same SqlDreamRepo class.

export { SqlDreamRepo } from "./sql-dream-repo";

import { SqlDreamRepo } from "./sql-dream-repo";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { DreamService, type DreamServiceDeps } from "../service";

type ExistenceDeps = Pick<
  DreamServiceDeps,
  "verifyMemoryStoreExists" | "verifySessionExists"
>;

/**
 * CF deployment factory. The caller passes the existence-check callbacks
 * because they bridge into the other services (memory, sessions). We
 * intentionally don't import those services here to avoid a dependency
 * cycle: services-package builds the `Services` container by wiring this
 * factory with the right callbacks.
 */
export function createCfDreamService(
  deps: { db: D1Database } & ExistenceDeps,
  opts?: { logger?: DreamServiceDeps["logger"] },
): DreamService {
  const sql = new CfD1SqlClient(deps.db);
  return new DreamService({
    repo: new SqlDreamRepo(sql),
    verifyMemoryStoreExists: deps.verifyMemoryStoreExists,
    verifySessionExists: deps.verifySessionExists,
    logger: opts?.logger,
  });
}

/** Self-host / SQLite factory. Same shape, different SqlClient. */
export function createSqliteDreamService(
  deps: { client: SqlClient } & ExistenceDeps,
  opts?: { logger?: DreamServiceDeps["logger"] },
): DreamService {
  return new DreamService({
    repo: new SqlDreamRepo(deps.client),
    verifyMemoryStoreExists: deps.verifyMemoryStoreExists,
    verifySessionExists: deps.verifySessionExists,
    logger: opts?.logger,
  });
}
