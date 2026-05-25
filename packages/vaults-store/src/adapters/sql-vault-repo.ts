import { and, asc, desc, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { vaults } from "@open-managed-agents/db-schema/cf-auth";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import {
  escapeLikePattern,
  fetchN,
  trimPage,
  type PageCursor,
} from "@open-managed-agents/shared";
import { VaultNotFoundError } from "../errors";
import type { NewVaultInput, VaultRepo, VaultUpdateFields } from "../ports";
import type { VaultRow } from "../types";

type Row = typeof vaults.$inferSelect;

/**
 * Drizzle-backed implementation of {@link VaultRepo}. Owns the SQL against
 * the `vaults` table defined in @open-managed-agents/db-schema/cf-auth.
 */
export class SqlVaultRepo implements VaultRepo {
  private readonly db: OmaDbBuilder;
  // Accept any schema specialisation; the TSchema generic on `OmaDb` is
  // invariant in Drizzle, so a caller that built `drizzle(d1, { schema:
  // cfAuthSchema })` would not satisfy the default `OmaDb` (TSchema =
  // Record<string, never>). Adapter doesn't read from the schema dictionary.
  constructor(db: OmaDb<Record<string, unknown>>) {
    this.db = asBuilder(db);
  }

  async insert(input: NewVaultInput): Promise<VaultRow> {
    await runOnce(
      this.db.insert(vaults).values({
        id: input.id,
        tenant_id: input.tenantId,
        name: input.name,
        created_at: input.createdAt,
      }),
    );
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("vault vanished after insert");
    return row;
  }

  async get(tenantId: string, vaultId: string): Promise<VaultRow | null> {
    const row = await getOne<Row>(
      this.db
        .select()
        .from(vaults)
        .where(
          and(eq(vaults.id, vaultId), eq(vaults.tenant_id, tenantId)),
        ),
    );
    return row ? toRow(row) : null;
  }

  async exists(tenantId: string, vaultId: string): Promise<boolean> {
    const row = await getOne<{ x: number }>(
      this.db
        .select({ x: sql<number>`1`.as("x") })
        .from(vaults)
        .where(
          and(eq(vaults.id, vaultId), eq(vaults.tenant_id, tenantId)),
        ),
    );
    return !!row;
  }

  async list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<VaultRow[]> {
    const conditions = [eq(vaults.tenant_id, tenantId)];
    if (!opts.includeArchived) conditions.push(isNull(vaults.archived_at));
    const rows = await getAll<Row>(
      this.db
        .select()
        .from(vaults)
        .where(and(...conditions))
        .orderBy(asc(vaults.created_at)),
    );
    return rows.map(toRow);
  }

  async listPage(
    tenantId: string,
    opts: {
      status?: "active" | "archived" | "any";
      includeArchived: boolean;
      createdAfter?: number;
      createdBefore?: number;
      limit: number;
      after?: PageCursor;
      q?: string;
    },
  ): Promise<{ items: VaultRow[]; hasMore: boolean }> {
    const conditions = [eq(vaults.tenant_id, tenantId)];
    // Prefer the new 3-way `status` filter. When unset, fall back to the
    // legacy includeArchived boolean so older callers keep working.
    if (opts.status === "active") {
      conditions.push(isNull(vaults.archived_at));
    } else if (opts.status === "archived") {
      conditions.push(isNotNull(vaults.archived_at));
    } else if (opts.status === undefined && !opts.includeArchived) {
      conditions.push(isNull(vaults.archived_at));
    }
    if (opts.createdAfter !== undefined)
      conditions.push(gte(vaults.created_at, opts.createdAfter));
    if (opts.createdBefore !== undefined)
      conditions.push(lt(vaults.created_at, opts.createdBefore));
    if (opts.q) {
      // Substring filter for the Combobox typeahead. SQLite's LIKE is
      // ASCII-case-insensitive by default and PG honours ESCAPE the same
      // way, so this query stays dialect-agnostic at the cost of one
      // raw-sql snippet.
      const pattern = `%${escapeLikePattern(opts.q)}%`;
      conditions.push(sql`${vaults.name} LIKE ${pattern} ESCAPE '\\'`);
    }
    if (opts.after) {
      // Cursor-as-WHERE: (created_at, id) DESC ordering means rows whose
      // created_at < cursor.createdAt OR (== cursor.createdAt AND id <
      // cursor.id) come AFTER the cursor in the page sequence.
      const after = opts.after;
      const cursorCond = or(
        lt(vaults.created_at, after.createdAt),
        and(
          eq(vaults.created_at, after.createdAt),
          lt(vaults.id, after.id),
        ),
      );
      if (cursorCond) conditions.push(cursorCond);
    }
    const rows = await getAll<Row>(
      this.db
        .select()
        .from(vaults)
        .where(and(...conditions))
        .orderBy(desc(vaults.created_at), desc(vaults.id))
        .limit(fetchN(opts.limit)),
    );
    return trimPage(rows.map(toRow), opts.limit);
  }

  async count(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<number> {
    const conditions = [eq(vaults.tenant_id, tenantId)];
    if (!opts.includeArchived) conditions.push(isNull(vaults.archived_at));
    const row = await getOne<{ c: number }>(
      this.db
        .select({ c: sql<number>`count(*)`.as("c") })
        .from(vaults)
        .where(and(...conditions)),
    );
    return row?.c ?? 0;
  }

  async update(
    tenantId: string,
    vaultId: string,
    update: VaultUpdateFields,
  ): Promise<VaultRow> {
    const sets: Partial<typeof vaults.$inferInsert> = {
      updated_at: update.updatedAt,
    };
    if (update.name !== undefined) sets.name = update.name;
    // UPDATE-then-GET: cross-dialect, the cleanest way to detect "row didn't
    // exist" is to read after the write. The original meta.changes check is
    // SQLite-specific; the GET below works the same on D1 + PG and matches
    // the existing service contract (404 → NotFound).
    await runOnce(
      this.db
        .update(vaults)
        .set(sets)
        .where(and(eq(vaults.id, vaultId), eq(vaults.tenant_id, tenantId))),
    );
    const row = await this.get(tenantId, vaultId);
    if (!row) throw new VaultNotFoundError();
    return row;
  }

  async archive(
    tenantId: string,
    vaultId: string,
    archivedAt: number,
  ): Promise<VaultRow> {
    await runOnce(
      this.db
        .update(vaults)
        .set({ archived_at: archivedAt, updated_at: archivedAt })
        .where(and(eq(vaults.id, vaultId), eq(vaults.tenant_id, tenantId))),
    );
    const row = await this.get(tenantId, vaultId);
    if (!row) throw new VaultNotFoundError();
    return row;
  }

  async delete(tenantId: string, vaultId: string): Promise<void> {
    await runOnce(
      this.db
        .delete(vaults)
        .where(and(eq(vaults.id, vaultId), eq(vaults.tenant_id, tenantId))),
    );
  }
}

function toRow(r: Row): VaultRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at !== null ? msToIso(r.updated_at) : null,
    archived_at: r.archived_at !== null ? msToIso(r.archived_at) : null,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
