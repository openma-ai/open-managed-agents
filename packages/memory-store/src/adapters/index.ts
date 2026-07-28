// Adapter wiring for the memory-store. Both CF (D1 + R2) and self-host
// (any OmaDb + any BlobStore) factories live here behind a single
// SqlMemoryRepo / SqlMemoryStoreRepo / SqlMemoryVersionRepo class trio.
//
// LocalFsBlobStore lives behind a subpath export
// (`@open-managed-agents/memory-store/adapters/local-fs-blob`) because it
// pulls Node-only imports (node:fs / node:crypto). Re-exporting it here
// would force the root CF tsc pass to typecheck Node types it doesn't have.
// Node consumers import it directly from the subpath.

export { SqlMemoryStoreRepo } from "./sql-store-repo";
export { SqlMemoryRepo } from "./sql-memory-repo";
export { SqlMemoryVersionRepo } from "./sql-version-repo";
export { CfR2BlobStore } from "./cf-r2";

import { SqlMemoryStoreRepo } from "./sql-store-repo";
import { SqlMemoryRepo } from "./sql-memory-repo";
import { SqlMemoryVersionRepo } from "./sql-version-repo";
import { CfR2BlobStore } from "./cf-r2";
import { drizzle } from "drizzle-orm/d1";
import type { OmaDb } from "@open-managed-agents/db-schema";
import { MemoryStoreService } from "../service";
import type { BlobStore, Logger } from "../ports";

/**
 * CF deployment factory: D1 for index/audit + R2 for content.
 *
 * The R2 binding is REQUIRED — memory content lives there. There is no noop
 * blob store fallback; if MEMORY_BUCKET isn't bound, the entire memory
 * subsystem is non-functional and we fail loudly at construction.
 */
export function createCfMemoryStoreService(
  deps: { db: D1Database; r2: R2Bucket },
  opts?: { logger?: Logger },
): MemoryStoreService {
  const drz = drizzle(deps.db);
  return new MemoryStoreService({
    storeRepo: new SqlMemoryStoreRepo(drz),
    memoryRepo: new SqlMemoryRepo(drz),
    versionRepo: new SqlMemoryVersionRepo(drz),
    blobs: new CfR2BlobStore(deps.r2),
    logger: opts?.logger,
  });
}

/**
 * Node deployment factory. Caller passes any {@link OmaDb} (typically a
 * postgres-js or better-sqlite3 Drizzle client) and any {@link BlobStore}
 * implementation. For the simplest self-host path, use postgres-js Drizzle
 * + LocalFsBlobStore. Production self-host can swap the BlobStore for an
 * S3-compatible adapter (Tigris / MinIO / etc.).
 */
export function createSqliteMemoryStoreService(
  deps: { db: OmaDb; blobs: BlobStore },
  opts?: { logger?: Logger },
): MemoryStoreService {
  return new MemoryStoreService({
    storeRepo: new SqlMemoryStoreRepo(deps.db),
    memoryRepo: new SqlMemoryRepo(deps.db),
    versionRepo: new SqlMemoryVersionRepo(deps.db),
    blobs: deps.blobs,
    logger: opts?.logger,
  });
}
