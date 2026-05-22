import { asc, eq, sql } from "drizzle-orm";
import { shard_pool } from "@open-managed-agents/db-schema/cf-router";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import type {
  NewShardPool,
  ShardPoolRepo,
  ShardPoolRow,
  ShardStatus,
} from "../ports";

type Row = typeof shard_pool.$inferSelect;

export class SqlShardPoolRepo implements ShardPoolRepo {
  private readonly db: OmaDbBuilder;
  // Accept any schema specialisation; see sql-tenant-shard-repo.ts for
  // the rationale.
  constructor(db: OmaDb<Record<string, unknown>>) {
    this.db = asBuilder(db);
  }

  async get(bindingName: string): Promise<ShardPoolRow | null> {
    const row = await getOne<Row>(
      this.db.select().from(shard_pool).where(eq(shard_pool.binding_name, bindingName)),
    );
    return row ? toDomain(row) : null;
  }

  async insert(input: NewShardPool): Promise<ShardPoolRow> {
    // Idempotent on PK collision — second registration of the same shard
    // preserves any operational state already accumulated.
    await runOnce(
      this.db
        .insert(shard_pool)
        .values({
          binding_name: input.bindingName,
          status: input.status ?? "open",
          tenant_count: 0,
          size_bytes: null,
          observed_at: null,
          notes: input.notes ?? null,
        })
        .onConflictDoNothing(),
    );
    const row = await this.get(input.bindingName);
    if (!row) throw new Error(`shard_pool row vanished after insert: ${input.bindingName}`);
    return row;
  }

  async pickOpen(): Promise<ShardPoolRow | null> {
    // Lowest tenant_count first; tie-break by smallest observed size; nulls
    // last (treat unknown size as "probably newest, use it"). The
    // CASE-WHEN-IS-NULL trick is portable across SQLite + PG (PG also
    // supports `NULLS LAST` natively, but the CASE form keeps the SQL
    // dialect-agnostic).
    const row = await getOne<Row>(
      this.db
        .select()
        .from(shard_pool)
        .where(eq(shard_pool.status, "open"))
        .orderBy(
          asc(shard_pool.tenant_count),
          sql`CASE WHEN ${shard_pool.size_bytes} IS NULL THEN 1 ELSE 0 END`,
          asc(shard_pool.size_bytes),
        )
        .limit(1),
    );
    return row ? toDomain(row) : null;
  }

  async setStatus(bindingName: string, status: ShardStatus): Promise<void> {
    await runOnce(
      this.db
        .update(shard_pool)
        .set({ status })
        .where(eq(shard_pool.binding_name, bindingName)),
    );
  }

  async setObservedSize(
    bindingName: string,
    sizeBytes: number,
    observedAt: number,
  ): Promise<void> {
    await runOnce(
      this.db
        .update(shard_pool)
        .set({ size_bytes: sizeBytes, observed_at: observedAt })
        .where(eq(shard_pool.binding_name, bindingName)),
    );
  }

  async incrementTenantCount(bindingName: string): Promise<void> {
    await runOnce(
      this.db
        .update(shard_pool)
        .set({ tenant_count: sql`${shard_pool.tenant_count} + 1` })
        .where(eq(shard_pool.binding_name, bindingName)),
    );
  }

  async listAll(): Promise<readonly ShardPoolRow[]> {
    const rows = await getAll<Row>(
      this.db.select().from(shard_pool).orderBy(shard_pool.binding_name),
    );
    return rows.map(toDomain);
  }
}

function toDomain(row: Row): ShardPoolRow {
  return {
    bindingName: row.binding_name,
    status: row.status as ShardStatus,
    tenantCount: row.tenant_count,
    sizeBytes: row.size_bytes,
    observedAt: row.observed_at,
    notes: row.notes,
  };
}
