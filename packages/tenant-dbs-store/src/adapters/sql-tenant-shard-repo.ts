import { eq } from "drizzle-orm";
import { tenant_shard } from "@open-managed-agents/db-schema/cf-router";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import type {
  NewTenantShard,
  TenantShardDirectoryRepo,
  TenantShardRow,
} from "../ports";

type Row = typeof tenant_shard.$inferSelect;

export class SqlTenantShardDirectoryRepo implements TenantShardDirectoryRepo {
  private readonly db: OmaDbBuilder;
  // The TSchema generic on `OmaDb` is invariant in Drizzle, so a caller
  // that built `drizzle(d1, { schema: cfRouterSchema })` would not satisfy
  // the default `OmaDb` (TSchema = Record<string, never>). Accept any
  // schema specialisation; the adapter doesn't use the schema dictionary.
  constructor(db: OmaDb<Record<string, unknown>>) {
    this.db = asBuilder(db);
  }

  async get(tenantId: string): Promise<TenantShardRow | null> {
    const row = await getOne<Row>(
      this.db.select().from(tenant_shard).where(eq(tenant_shard.tenant_id, tenantId)),
    );
    return row ? toDomain(row) : null;
  }

  async insert(input: NewTenantShard): Promise<TenantShardRow> {
    const now = Date.now();
    // INSERT OR IGNORE: re-running sign-up for an existing tenant must NOT
    // accidentally re-route to a different shard. The first assignment wins
    // and stays for the lifetime of the tenant.
    await runOnce(
      this.db
        .insert(tenant_shard)
        .values({
          tenant_id: input.tenantId,
          binding_name: input.bindingName,
          created_at: now,
        })
        .onConflictDoNothing(),
    );
    const row = await this.get(input.tenantId);
    if (!row) throw new Error(`tenant_shard row vanished after insert: ${input.tenantId}`);
    return row;
  }

  async reassign(tenantId: string, bindingName: string): Promise<void> {
    await runOnce(
      this.db
        .update(tenant_shard)
        .set({ binding_name: bindingName })
        .where(eq(tenant_shard.tenant_id, tenantId)),
    );
  }

  async listAll(): Promise<readonly TenantShardRow[]> {
    const rows = await getAll<Row>(
      this.db.select().from(tenant_shard).orderBy(tenant_shard.created_at),
    );
    return rows.map(toDomain);
  }
}

function toDomain(row: Row): TenantShardRow {
  return {
    tenantId: row.tenant_id,
    bindingName: row.binding_name,
    createdAt: row.created_at,
  };
}
