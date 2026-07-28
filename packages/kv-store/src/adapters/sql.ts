// Drizzle-backed KvStore. Schema lives in @open-managed-agents/db-schema
// (kv_entries table). Tenant scoping: keys are partitioned by tenant_id;
// callers pass the active tenant via the constructor. This is the
// self-host cousin of CfKvStore — same KvStore port, different backing.
//
// Why per-tenant scoping in the adapter (not in keys): consumers of KV
// (quotas, api-keys, oauth state, skill metadata) already build keys
// scoped to a tenant. Pulling tenant_id into a separate column lets
// "delete tenant" be one SQL statement instead of a prefix scan.

import { and, asc, eq, gt, isNull, like, or, sql } from "drizzle-orm";
import { kv_entries } from "@open-managed-agents/db-schema/cf-auth";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import type {
  KvListKey,
  KvListOptions,
  KvListResult,
  KvPutOptions,
  KvStore,
} from "../ports";

export interface SqlKvStoreOpts {
  // Accept any schema specialisation; the TSchema generic on `OmaDb` is
  // invariant in Drizzle, so a caller that built `drizzle(d1, { schema:
  // cfAuthSchema })` would not satisfy the default `OmaDb` (TSchema =
  // Record<string, never>). Adapter doesn't read from the schema dictionary.
  db: OmaDb<Record<string, unknown>>;
  /** Tenant scope. Required — keys never collide across tenants. Use a
   *  literal "default" for AUTH_DISABLED mode. */
  tenantId: string;
}

type Row = typeof kv_entries.$inferSelect;


export class SqlKvStore implements KvStore {
  private readonly db: OmaDbBuilder;
  constructor(private readonly opts: SqlKvStoreOpts) {
    this.db = asBuilder(opts.db);
  }

  async get(key: string): Promise<string | null> {
    const row = await getOne<Pick<Row, "value" | "expires_at">>(
      this.db
        .select({
          value: kv_entries.value,
          expires_at: kv_entries.expires_at,
        })
        .from(kv_entries)
        .where(
          and(
            eq(kv_entries.tenant_id, this.opts.tenantId),
            eq(kv_entries.key, key),
          ),
        ),
    );
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      // Lazy purge.
      await runOnce(
        this.db
          .delete(kv_entries)
          .where(
            and(
              eq(kv_entries.tenant_id, this.opts.tenantId),
              eq(kv_entries.key, key),
            ),
          ),
      );
      return null;
    }
    return row.value;
  }

  async put(key: string, value: string, opts?: KvPutOptions): Promise<void> {
    let expiresAt: number | null = null;
    if (opts?.expirationTtl !== undefined) {
      expiresAt = Date.now() + opts.expirationTtl * 1000;
    } else if (opts?.expiration !== undefined) {
      expiresAt = opts.expiration * 1000;
    }
    // UPSERT on (tenant_id, key) PK — second write wins, including TTL reset.
    await runOnce(
      this.db
        .insert(kv_entries)
        .values({
          tenant_id: this.opts.tenantId,
          key,
          value,
          expires_at: expiresAt,
        })
        .onConflictDoUpdate({
          target: [kv_entries.tenant_id, kv_entries.key],
          set: {
            value: sql`excluded.value`,
            expires_at: sql`excluded.expires_at`,
          },
        }),
    );
  }

  async delete(key: string): Promise<void> {
    await runOnce(
      this.db
        .delete(kv_entries)
        .where(
          and(
            eq(kv_entries.tenant_id, this.opts.tenantId),
            eq(kv_entries.key, key),
          ),
        ),
    );
  }

  async list(opts?: KvListOptions): Promise<KvListResult> {
    const prefix = opts?.prefix ?? "";
    const limit = Math.max(1, Math.min(opts?.limit ?? 1000, 1000));
    const offset = opts?.cursor ? parseCursor(opts.cursor) : 0;
    const now = Date.now();
    // Filter out keys whose TTL has elapsed without paying for a separate
    // GC pass. Hot reads handle their own purge in get().
    const rows = await getAll<{ name: string; expires_at: number | null }>(
      this.db
        .select({
          name: kv_entries.key,
          expires_at: kv_entries.expires_at,
        })
        .from(kv_entries)
        .where(
          and(
            eq(kv_entries.tenant_id, this.opts.tenantId),
            like(kv_entries.key, `${prefix}%`),
            or(isNull(kv_entries.expires_at), gt(kv_entries.expires_at, now)),
          ),
        )
        .orderBy(asc(kv_entries.key))
        .limit(limit + 1)
        .offset(offset),
    );
    const has_more = rows.length > limit;
    const sliced = rows.slice(0, limit);
    return {
      keys: sliced.map<KvListKey>((r) => ({
        name: r.name,
        expiration:
          r.expires_at !== null ? Math.floor(r.expires_at / 1000) : undefined,
      })),
      list_complete: !has_more,
      cursor: has_more ? encodeCursor(offset + limit) : undefined,
    };
  }
}

function encodeCursor(idx: number): string {
  return Buffer.from(String(idx)).toString("base64");
}

function parseCursor(c: string): number {
  try {
    const n = Number.parseInt(Buffer.from(c, "base64").toString("utf8"), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
