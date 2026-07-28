import { eq } from "drizzle-orm";
import { memory_store_tenant } from "@open-managed-agents/db-schema/cf-router";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import type {
  MemoryStoreTenantIndexRepo,
  MemoryStoreTenantRow,
} from "../ports";

type Row = typeof memory_store_tenant.$inferSelect;

/**
 * SQL adapter for the memory_store → tenant index. Same shape as the
 * sibling tenant_shard / shard_pool repos: depends only on the OmaDb
 * port, no CF-specific types. Schema lives in
 * apps/main/migrations-router/0002_memory_store_tenant.sql.
 */
export class SqlMemoryStoreTenantIndexRepo implements MemoryStoreTenantIndexRepo {
  private readonly db: OmaDbBuilder;
  // Accept any schema specialisation; see sql-tenant-shard-repo.ts for
  // the rationale.
  constructor(db: OmaDb<Record<string, unknown>>) {
    this.db = asBuilder(db);
  }

  async lookup(storeId: string): Promise<string | null> {
    const row = await getOne<Pick<Row, "tenant_id">>(
      this.db
        .select({ tenant_id: memory_store_tenant.tenant_id })
        .from(memory_store_tenant)
        .where(eq(memory_store_tenant.store_id, storeId)),
    );
    return row?.tenant_id ?? null;
  }

  async register(storeId: string, tenantId: string, nowMs: number): Promise<void> {
    // INSERT OR IGNORE: a retried createStore must NOT re-route the
    // store to a different tenant. First registration wins.
    await runOnce(
      this.db
        .insert(memory_store_tenant)
        .values({
          store_id: storeId,
          tenant_id: tenantId,
          created_at: nowMs,
        })
        .onConflictDoNothing(),
    );
  }

  async listAll(): Promise<readonly MemoryStoreTenantRow[]> {
    const rows = await getAll<Row>(
      this.db
        .select()
        .from(memory_store_tenant)
        .orderBy(memory_store_tenant.created_at),
    );
    return rows.map(toDomain);
  }
}

function toDomain(row: Row): MemoryStoreTenantRow {
  return {
    storeId: row.store_id,
    tenantId: row.tenant_id,
    createdAt: row.created_at,
  };
}
