// Adapter wiring for the control-plane shard router store. All reads and
// writes target the control-plane DB (env.MAIN_DB on CF, the shared
// Drizzle DB on the self-host build).

export { SqlTenantShardDirectoryRepo } from "./sql-tenant-shard-repo";
export { SqlShardPoolRepo } from "./sql-shard-pool-repo";
export { SqlMemoryStoreTenantIndexRepo } from "./sql-memory-store-tenant-index-repo";

import { drizzle } from "drizzle-orm/d1";
import * as cfRouterSchema from "@open-managed-agents/db-schema/cf-router";
import type { OmaDb } from "@open-managed-agents/db-schema";
import type { SqlClient } from "@open-managed-agents/sql-client";
import { SqlTenantShardDirectoryRepo } from "./sql-tenant-shard-repo";
import { SqlShardPoolRepo } from "./sql-shard-pool-repo";
import { SqlMemoryStoreTenantIndexRepo } from "./sql-memory-store-tenant-index-repo";
import {
  TenantShardDirectoryService,
  ShardPoolService,
  MemoryStoreTenantIndexService,
} from "../service";

export function createCfTenantShardDirectoryService(deps: {
  controlPlaneDb: D1Database;
}): TenantShardDirectoryService {
  const db = drizzle(deps.controlPlaneDb, { schema: cfRouterSchema });
  return new TenantShardDirectoryService(new SqlTenantShardDirectoryRepo(db));
}

export function createCfShardPoolService(deps: {
  controlPlaneDb: D1Database;
}): ShardPoolService {
  const db = drizzle(deps.controlPlaneDb, { schema: cfRouterSchema });
  return new ShardPoolService(new SqlShardPoolRepo(db));
}

export function createCfMemoryStoreTenantIndexService(deps: {
  controlPlaneDb: D1Database;
}): MemoryStoreTenantIndexService {
  const db = drizzle(deps.controlPlaneDb, { schema: cfRouterSchema });
  return new MemoryStoreTenantIndexService(
    new SqlMemoryStoreTenantIndexRepo(db),
  );
}

// Self-host (Node SQLite / Postgres) factories. The Phase 6 plan flips the
// signature from raw SqlClient to Drizzle OmaDb. Composition root in apps
// constructs Drizzle from better-sqlite3 / postgres.js and passes it here.
//
// The legacy `{ client: SqlClient }` shape is intentionally rejected — it
// would force this package to depend on @open-managed-agents/sql-client
// which we're decommissioning. Update the caller to construct Drizzle.

type SqliteFactoryDeps = { client: SqlClient } | { db: OmaDb };

export function createSqliteTenantShardDirectoryService(
  deps: SqliteFactoryDeps,
): TenantShardDirectoryService {
  if ("db" in deps) {
    return new TenantShardDirectoryService(
      new SqlTenantShardDirectoryRepo(deps.db),
    );
  }
  throw new Error(
    "createSqliteTenantShardDirectoryService now requires { db: OmaDb }; see Phase 6 plan.",
  );
}

export function createSqliteShardPoolService(
  deps: SqliteFactoryDeps,
): ShardPoolService {
  if ("db" in deps) {
    return new ShardPoolService(new SqlShardPoolRepo(deps.db));
  }
  throw new Error(
    "createSqliteShardPoolService now requires { db: OmaDb }; see Phase 6 plan.",
  );
}

export function createSqliteMemoryStoreTenantIndexService(
  deps: SqliteFactoryDeps,
): MemoryStoreTenantIndexService {
  if ("db" in deps) {
    return new MemoryStoreTenantIndexService(
      new SqlMemoryStoreTenantIndexRepo(deps.db),
    );
  }
  throw new Error(
    "createSqliteMemoryStoreTenantIndexService now requires { db: OmaDb }; see Phase 6 plan.",
  );
}
