import { and, desc, eq, gte, isNotNull, isNull, lt } from "drizzle-orm";
import {
  asBuilder,
  atomicWrite,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import {
  memories,
  memory_stores,
  memory_versions,
} from "@open-managed-agents/db-schema/cf-auth";
import type { MemoryStoreRepo, NewMemoryStoreInput } from "../ports";
import type { MemoryStoreRow } from "../types";


/**
 * Drizzle implementation of {@link MemoryStoreRepo}. Owns the SQL against the
 * memory_stores table.
 *
 * Backend-agnostic: takes an {@link OmaDb} (Drizzle wrapper around D1 /
 * better-sqlite3 / postgres-js). Helpers in `@open-managed-agents/db-schema`
 * paper over the SQLite vs PG terminator differences.
 */
export class SqlMemoryStoreRepo implements MemoryStoreRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async insert(input: NewMemoryStoreInput): Promise<MemoryStoreRow> {
    await runOnce(
      this.db.insert(memory_stores).values({
        id: input.id,
        tenant_id: input.tenantId,
        name: input.name,
        description: input.description,
        created_at: input.createdAt,
        updated_at: null,
        archived_at: null,
      }),
    );
    return {
      id: input.id,
      tenant_id: input.tenantId,
      name: input.name,
      description: input.description,
      created_at: msToIso(input.createdAt),
      updated_at: null,
      archived_at: null,
    };
  }

  async get(tenantId: string, storeId: string): Promise<MemoryStoreRow | null> {
    const row = await getOne<typeof memory_stores.$inferSelect>(
      this.db
        .select()
        .from(memory_stores)
        .where(and(eq(memory_stores.id, storeId), eq(memory_stores.tenant_id, tenantId))),
    );
    return row ? toRow(row) : null;
  }

  async list(
    tenantId: string,
    opts: {
      includeArchived: boolean;
      status?: "active" | "archived" | "any";
      createdAfter?: number;
      createdBefore?: number;
    },
  ): Promise<MemoryStoreRow[]> {
    const conds = [eq(memory_stores.tenant_id, tenantId)];
    // `status` is the canonical 3-way filter; fall back to includeArchived
    // when callers haven't been migrated yet. `'any'` is a no-op WHERE.
    const status =
      opts.status ?? (opts.includeArchived ? "any" : "active");
    if (status === "active") conds.push(isNull(memory_stores.archived_at));
    else if (status === "archived") conds.push(isNotNull(memory_stores.archived_at));
    if (opts.createdAfter !== undefined)
      conds.push(gte(memory_stores.created_at, opts.createdAfter));
    if (opts.createdBefore !== undefined)
      conds.push(lt(memory_stores.created_at, opts.createdBefore));
    const rows = await getAll<typeof memory_stores.$inferSelect>(
      this.db
        .select()
        .from(memory_stores)
        .where(and(...conds))
        .orderBy(desc(memory_stores.created_at)),
    );
    return rows.map(toRow);
  }

  async archive(tenantId: string, storeId: string, archivedAt: number): Promise<MemoryStoreRow> {
    await runOnce(
      this.db
        .update(memory_stores)
        .set({ archived_at: archivedAt, updated_at: archivedAt })
        .where(and(eq(memory_stores.id, storeId), eq(memory_stores.tenant_id, tenantId))),
    );
    const row = await this.get(tenantId, storeId);
    if (!row) throw new Error(`memory_stores ${storeId} vanished after archive`);
    return row;
  }

  async update(
    tenantId: string,
    storeId: string,
    fields: { name?: string; description?: string | null; updatedAt: number },
  ): Promise<MemoryStoreRow> {
    const set: Record<string, unknown> = { updated_at: fields.updatedAt };
    if (fields.name !== undefined) set.name = fields.name;
    if (fields.description !== undefined) set.description = fields.description;
    await runOnce(
      this.db
        .update(memory_stores)
        .set(set)
        .where(and(eq(memory_stores.id, storeId), eq(memory_stores.tenant_id, tenantId))),
    );
    const row = await this.get(tenantId, storeId);
    if (!row) throw new Error(`memory_stores ${storeId} vanished after update`);
    return row;
  }

  async delete(tenantId: string, storeId: string): Promise<void> {
    // App-layer cascade: explicitly drop memory_versions + memories before the
    // store row. Atomic across all three statements via the shared atomicWrite
    // helper (D1 batch / PG transaction — adapter stays dialect-blind).
    await atomicWrite(this.db, [
      this.db.delete(memory_versions).where(eq(memory_versions.store_id, storeId)),
      this.db.delete(memories).where(eq(memories.store_id, storeId)),
      this.db
        .delete(memory_stores)
        .where(and(eq(memory_stores.id, storeId), eq(memory_stores.tenant_id, tenantId))),
    ]);
  }
}

function toRow(r: typeof memory_stores.$inferSelect): MemoryStoreRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    description: r.description,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at ? msToIso(r.updated_at) : null,
    archived_at: r.archived_at ? msToIso(r.archived_at) : null,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
