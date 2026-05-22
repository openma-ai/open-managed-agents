import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { memory_versions } from "@open-managed-agents/db-schema/cf-auth";
import type { MemoryVersionRepo } from "../ports";
import type { Actor, MemoryVersionRow } from "../types";


/**
 * Drizzle implementation of {@link MemoryVersionRepo}. Read + redact
 * paths over the memory_versions table; the write path lives in
 * {@link SqlMemoryRepo} because every version write is paired with a memory
 * mutation in the same atomic batch.
 */
export class SqlMemoryVersionRepo implements MemoryVersionRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async list(
    storeId: string,
    opts: { memoryId?: string; limit: number },
  ): Promise<MemoryVersionRow[]> {
    const conds = [eq(memory_versions.store_id, storeId)];
    if (opts.memoryId) conds.push(eq(memory_versions.memory_id, opts.memoryId));
    const rows = await getAll<typeof memory_versions.$inferSelect>(
      this.db
        .select()
        .from(memory_versions)
        .where(and(...conds))
        .orderBy(desc(memory_versions.created_at))
        .limit(opts.limit),
    );
    return rows.map(toRow);
  }

  async get(storeId: string, versionId: string): Promise<MemoryVersionRow | null> {
    const row = await getOne<typeof memory_versions.$inferSelect>(
      this.db
        .select()
        .from(memory_versions)
        .where(and(eq(memory_versions.id, versionId), eq(memory_versions.store_id, storeId))),
    );
    return row ? toRow(row) : null;
  }

  async redact(storeId: string, versionId: string): Promise<MemoryVersionRow> {
    await runOnce(
      this.db
        .update(memory_versions)
        .set({
          path: null,
          content: null,
          content_sha256: null,
          size_bytes: null,
          redacted: 1,
        })
        .where(and(eq(memory_versions.id, versionId), eq(memory_versions.store_id, storeId))),
    );
    const row = await this.get(storeId, versionId);
    if (!row) throw new Error(`memory_versions ${versionId} vanished after redact`);
    return row;
  }

  /**
   * Drop versions older than `cutoffMs` EXCEPT the most recent per memory_id.
   * Mirrors Anthropic's retention rule:
   *   "Versions are retained for 30 days; however, the recent versions are
   *    always kept regardless of age, so memories that change infrequently
   *    may retain history beyond 30 days."
   *
   * Returns rows-deleted count for cron observability. Returns -1 when the
   * driver doesn't surface a row count (D1 .run() doesn't always populate it).
   *
   * The latest-per-memory subquery joins memory_versions to itself via a
   * GROUP BY MAX(created_at) — too complex for Drizzle's typed builder, so
   * the NOT IN subquery is hand-written via sql``. The outer DELETE stays
   * builder-typed.
   *
   * TODO: PG path needs json_extract → ->> rewrite — N/A here, but the
   * sub-select uses SQLite's correlated alias syntax. PG accepts the same
   * shape (it's standard SQL), so this should also run unchanged on PG.
   */
  async pruneOlderThan(cutoffMs: number): Promise<number> {
    const chain = this.db
      .delete(memory_versions)
      .where(
        and(
          lt(memory_versions.created_at, cutoffMs),
          sql`${memory_versions.id} NOT IN (
            SELECT v.id FROM memory_versions v
            JOIN (
              SELECT memory_id, MAX(created_at) AS max_at
              FROM memory_versions GROUP BY memory_id
            ) latest
            ON v.memory_id = latest.memory_id AND v.created_at = latest.max_at
          )`,
        ),
      );

    // SQLite chains expose `.run()` (sync better-sqlite3, async D1); PG awaits
    // the chain directly. Detect & dispatch to keep the row-count surface unified.
    const result = await (typeof (chain as { run?: unknown }).run === "function"
      ? (chain as unknown as { run: () => Promise<unknown> }).run()
      : (chain as unknown as Promise<unknown>));

    // D1 → { meta: { changes? } }; postgres-js → { count? }; better-sqlite3 → { changes? }.
    const r = result as
      | {
          meta?: { changes?: number };
          count?: number;
          rowCount?: number;
          changes?: number;
        }
      | undefined;
    const changes = r?.meta?.changes ?? r?.count ?? r?.rowCount ?? r?.changes;
    return typeof changes === "number" ? changes : -1;
  }
}

function toRow(r: typeof memory_versions.$inferSelect): MemoryVersionRow {
  return {
    id: r.id,
    memory_id: r.memory_id,
    store_id: r.store_id,
    operation: r.operation as MemoryVersionRow["operation"],
    path: r.path,
    content: r.content,
    content_sha256: r.content_sha256,
    size_bytes: r.size_bytes,
    actor_type: r.actor_type as Actor["type"],
    actor_id: r.actor_id,
    created_at: msToIso(r.created_at),
    redacted: r.redacted === 1,
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
