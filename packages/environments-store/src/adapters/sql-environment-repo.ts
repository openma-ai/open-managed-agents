import { and, asc, desc, eq, gte, isNotNull, isNull, like, lt, or, sql } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { environments } from "@open-managed-agents/db-schema/cf-auth";
import type { EnvironmentConfig, PageCursor } from "@open-managed-agents/shared";
import { escapeLikePattern, fetchN, trimPage } from "@open-managed-agents/shared";
import { EnvironmentNotFoundError } from "../errors";
import type {
  EnvironmentRepo,
  EnvironmentUpdateFields,
  NewEnvironmentInput,
} from "../ports";
import type { EnvironmentRow, EnvironmentStatus } from "../types";


/**
 * Drizzle implementation of {@link EnvironmentRepo}. Owns the queries against
 * the `environments` table defined in apps/main/migrations/0003_environments_table.sql.
 *
 * Hot fields (status, sandbox_worker_name) live in their own columns so the
 * sandbox-binding resolver in routes/sessions.ts (and friends) can read them
 * without parsing the `config` JSON.
 */
export class SqlEnvironmentRepo implements EnvironmentRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async insert(input: NewEnvironmentInput): Promise<EnvironmentRow> {
    await runOnce(
      this.db.insert(environments).values({
        id: input.id,
        tenant_id: input.tenantId,
        name: input.name,
        description: input.description,
        status: input.status,
        sandbox_worker_name: input.sandboxWorkerName,
        build_error: input.buildError,
        config: JSON.stringify(input.config),
        metadata: input.metadata !== null ? JSON.stringify(input.metadata) : null,
        image_strategy: input.imageStrategy ?? null,
        image_handle:
          input.imageHandle !== undefined && input.imageHandle !== null
            ? JSON.stringify(input.imageHandle)
            : null,
        created_at: input.createdAt,
      }),
    );
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("environment vanished after insert");
    return row;
  }

  async get(
    tenantId: string,
    environmentId: string,
  ): Promise<EnvironmentRow | null> {
    const row = await getOne<typeof environments.$inferSelect>(
      this.db
        .select()
        .from(environments)
        .where(
          and(
            eq(environments.id, environmentId),
            eq(environments.tenant_id, tenantId),
          ),
        ),
    );
    return row ? toRow(row) : null;
  }

  async list(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<EnvironmentRow[]> {
    const conds = [eq(environments.tenant_id, tenantId)];
    if (!opts.includeArchived) conds.push(isNull(environments.archived_at));
    const rows = await getAll<typeof environments.$inferSelect>(
      this.db
        .select()
        .from(environments)
        .where(and(...conds))
        .orderBy(asc(environments.created_at)),
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
  ): Promise<{ items: EnvironmentRow[]; hasMore: boolean }> {
    const conds = [eq(environments.tenant_id, tenantId)];
    // Prefer the new 3-way `status` filter. When unset, fall back to the
    // legacy includeArchived boolean so older callers keep working.
    if (opts.status === "active") {
      conds.push(isNull(environments.archived_at));
    } else if (opts.status === "archived") {
      conds.push(isNotNull(environments.archived_at));
    } else if (opts.status === undefined && !opts.includeArchived) {
      conds.push(isNull(environments.archived_at));
    }
    if (opts.createdAfter !== undefined)
      conds.push(gte(environments.created_at, opts.createdAfter));
    if (opts.createdBefore !== undefined)
      conds.push(lt(environments.created_at, opts.createdBefore));
    if (opts.q) {
      conds.push(like(environments.name, `%${escapeLikePattern(opts.q)}%`));
    }
    if (opts.after) {
      // Cursor: rows older than (created_at, id) DESC.
      conds.push(
        or(
          lt(environments.created_at, opts.after.createdAt),
          and(
            eq(environments.created_at, opts.after.createdAt),
            lt(environments.id, opts.after.id),
          ),
        )!,
      );
    }
    const rows = await getAll<typeof environments.$inferSelect>(
      this.db
        .select()
        .from(environments)
        .where(and(...conds))
        .orderBy(desc(environments.created_at), desc(environments.id))
        .limit(fetchN(opts.limit)),
    );
    return trimPage(rows.map(toRow), opts.limit);
  }

  async count(
    tenantId: string,
    opts: { includeArchived: boolean },
  ): Promise<number> {
    const conds = [eq(environments.tenant_id, tenantId)];
    if (!opts.includeArchived) conds.push(isNull(environments.archived_at));
    const row = await getOne<{ c: number }>(
      this.db
        .select({ c: sql<number>`COUNT(*)` })
        .from(environments)
        .where(and(...conds)),
    );
    return row?.c ?? 0;
  }

  async update(
    tenantId: string,
    environmentId: string,
    update: EnvironmentUpdateFields,
  ): Promise<EnvironmentRow> {
    // Pre-check existence — Drizzle's run() result shape is dialect-specific,
    // so we read first to throw a domain error if the row is missing.
    const existing = await this.get(tenantId, environmentId);
    if (!existing) throw new EnvironmentNotFoundError();

    const set: Record<string, unknown> = { updated_at: update.updatedAt };
    if (update.name !== undefined) set.name = update.name;
    if (update.description !== undefined) set.description = update.description;
    if (update.status !== undefined) set.status = update.status;
    if (update.sandboxWorkerName !== undefined) {
      set.sandbox_worker_name = update.sandboxWorkerName;
    }
    if (update.buildError !== undefined) set.build_error = update.buildError;
    if (update.config !== undefined) {
      set.config = JSON.stringify(update.config);
    }
    if (update.metadata !== undefined) {
      set.metadata = update.metadata !== null ? JSON.stringify(update.metadata) : null;
    }
    if (update.imageStrategy !== undefined) {
      set.image_strategy = update.imageStrategy;
    }
    if (update.imageHandle !== undefined) {
      set.image_handle =
        update.imageHandle !== null ? JSON.stringify(update.imageHandle) : null;
    }

    await runOnce(
      this.db
        .update(environments)
        .set(set)
        .where(
          and(
            eq(environments.id, environmentId),
            eq(environments.tenant_id, tenantId),
          ),
        ),
    );
    const row = await this.get(tenantId, environmentId);
    if (!row) throw new EnvironmentNotFoundError();
    return row;
  }

  async archive(
    tenantId: string,
    environmentId: string,
    archivedAt: number,
  ): Promise<EnvironmentRow> {
    const existing = await this.get(tenantId, environmentId);
    if (!existing) throw new EnvironmentNotFoundError();
    await runOnce(
      this.db
        .update(environments)
        .set({ archived_at: archivedAt, updated_at: archivedAt })
        .where(
          and(
            eq(environments.id, environmentId),
            eq(environments.tenant_id, tenantId),
          ),
        ),
    );
    const row = await this.get(tenantId, environmentId);
    if (!row) throw new EnvironmentNotFoundError();
    return row;
  }

  async delete(tenantId: string, environmentId: string): Promise<void> {
    await runOnce(
      this.db
        .delete(environments)
        .where(
          and(
            eq(environments.id, environmentId),
            eq(environments.tenant_id, tenantId),
          ),
        ),
    );
  }
}

function toRow(r: typeof environments.$inferSelect): EnvironmentRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    description: r.description,
    status: r.status as EnvironmentStatus,
    sandbox_worker_name: r.sandbox_worker_name,
    build_error: r.build_error,
    config: JSON.parse(r.config) as EnvironmentConfig["config"],
    metadata: r.metadata !== null ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    image_strategy: (r.image_strategy as EnvironmentRow["image_strategy"]) ?? null,
    image_handle:
      r.image_handle !== null ? (JSON.parse(r.image_handle) as Record<string, unknown>) : null,
    created_at: msToIso(r.created_at),
    updated_at: r.updated_at !== null ? msToIso(r.updated_at) : null,
    archived_at: r.archived_at !== null ? msToIso(r.archived_at) : null,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
