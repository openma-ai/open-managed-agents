import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  DreamListOptions,
  DreamRepo,
  DreamUpdateFields,
  NewDreamInput,
} from "../ports";
import {
  DreamError,
  DreamModel,
  DreamRow,
  DreamStatus,
  DreamUsage,
  NON_TERMINAL_STATUSES,
  SUPPORTED_DREAM_MODELS,
  ZERO_USAGE,
} from "../types";

/**
 * SQL implementation of {@link DreamRepo}. Mirrors the schema in
 * apps/main/migrations/0017_dreams.sql.
 *
 * Backend-agnostic: takes any {@link SqlClient} so the same statements work
 * against D1 and better-sqlite3 / Postgres (self-host). JSON columns
 * (`input_session_ids`, `usage`, `error`) are encoded at the boundary; the
 * caller never sees raw SQL strings.
 */
export class SqlDreamRepo implements DreamRepo {
  constructor(private readonly db: SqlClient) {}

  async insert(input: NewDreamInput): Promise<DreamRow> {
    await this.db
      .prepare(
        `INSERT INTO dreams (
           id, tenant_id, status,
           input_memory_store_id, input_session_ids,
           output_memory_store_id,
           model, instructions, session_id,
           usage, error,
           created_at, started_at, ended_at, archived_at
         ) VALUES (?, ?, 'pending', ?, ?, NULL, ?, ?, NULL, ?, NULL, ?, NULL, NULL, NULL)`,
      )
      .bind(
        input.id,
        input.tenantId,
        input.inputMemoryStoreId,
        JSON.stringify(input.inputSessionIds),
        input.model,
        input.instructions,
        JSON.stringify(ZERO_USAGE),
        input.createdAt,
      )
      .run();
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error(`dream ${input.id} vanished after insert`);
    return row;
  }

  async get(tenantId: string, dreamId: string): Promise<DreamRow | null> {
    const row = await this.db
      .prepare(`${SELECT_COLS} WHERE id = ? AND tenant_id = ?`)
      .bind(dreamId, tenantId)
      .first<DbDream>();
    return row ? toRow(row) : null;
  }

  async list(
    tenantId: string,
    opts: DreamListOptions,
  ): Promise<{ items: DreamRow[]; hasMore: boolean }> {
    // Newest first, id desc tie-break. Cursor encodes (created_at_ms, id):
    // keep moving backwards through the chronologically-sorted list.
    // We fetch one extra row to detect hasMore without a separate COUNT.
    const limit = opts.limit;
    const binds: unknown[] = [tenantId];
    let where = "WHERE tenant_id = ?";
    if (!opts.includeArchived) where += " AND archived_at IS NULL";
    if (opts.after) {
      where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
      binds.push(opts.after.createdAtMs, opts.after.createdAtMs, opts.after.id);
    }
    const sql = `${SELECT_COLS} ${where} ORDER BY created_at DESC, id DESC LIMIT ?`;
    binds.push(limit + 1);
    const result = await this.db.prepare(sql).bind(...binds).all<DbDream>();
    const rows = (result.results ?? []).map(toRow);
    const hasMore = rows.length > limit;
    return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  async update(
    tenantId: string,
    dreamId: string,
    fields: DreamUpdateFields,
  ): Promise<DreamRow> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.status !== undefined) {
      sets.push("status = ?");
      binds.push(fields.status);
    }
    if (fields.outputMemoryStoreId !== undefined) {
      sets.push("output_memory_store_id = ?");
      binds.push(fields.outputMemoryStoreId);
    }
    if (fields.sessionId !== undefined) {
      sets.push("session_id = ?");
      binds.push(fields.sessionId);
    }
    if (fields.usage !== undefined) {
      sets.push("usage = ?");
      binds.push(JSON.stringify(fields.usage));
    }
    if (fields.error !== undefined) {
      sets.push("error = ?");
      binds.push(fields.error ? JSON.stringify(fields.error) : null);
    }
    if (fields.startedAt !== undefined) {
      sets.push("started_at = ?");
      binds.push(fields.startedAt);
    }
    if (fields.endedAt !== undefined) {
      sets.push("ended_at = ?");
      binds.push(fields.endedAt);
    }
    if (sets.length === 0) {
      const row = await this.get(tenantId, dreamId);
      if (!row) throw new Error(`dream ${dreamId} not found`);
      return row;
    }
    binds.push(dreamId, tenantId);
    await this.db
      .prepare(`UPDATE dreams SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`)
      .bind(...binds)
      .run();
    const row = await this.get(tenantId, dreamId);
    if (!row) throw new Error(`dream ${dreamId} vanished after update`);
    return row;
  }

  async archive(
    tenantId: string,
    dreamId: string,
    archivedAt: number,
  ): Promise<DreamRow> {
    await this.db
      .prepare(`UPDATE dreams SET archived_at = ? WHERE id = ? AND tenant_id = ?`)
      .bind(archivedAt, dreamId, tenantId)
      .run();
    const row = await this.get(tenantId, dreamId);
    if (!row) throw new Error(`dream ${dreamId} vanished after archive`);
    return row;
  }

  async findActiveByInputStore(tenantId: string, storeId: string): Promise<DreamRow[]> {
    const placeholders = NON_TERMINAL_STATUSES.map(() => "?").join(",");
    const result = await this.db
      .prepare(
        `${SELECT_COLS} WHERE tenant_id = ? AND input_memory_store_id = ? AND status IN (${placeholders})`,
      )
      .bind(tenantId, storeId, ...NON_TERMINAL_STATUSES)
      .all<DbDream>();
    return (result.results ?? []).map(toRow);
  }

  async findActiveByOutputStore(tenantId: string, storeId: string): Promise<DreamRow[]> {
    const placeholders = NON_TERMINAL_STATUSES.map(() => "?").join(",");
    const result = await this.db
      .prepare(
        `${SELECT_COLS} WHERE tenant_id = ? AND output_memory_store_id = ? AND status IN (${placeholders})`,
      )
      .bind(tenantId, storeId, ...NON_TERMINAL_STATUSES)
      .all<DbDream>();
    return (result.results ?? []).map(toRow);
  }

  async findStuckRunning(opts: {
    staleBeforeMs: number;
    limit: number;
  }): Promise<DreamRow[]> {
    // Cross-tenant: the cron sweep runs per-shard, not per-tenant. We
    // bound by `limit` so a single tick can't blow up on a shard with
    // thousands of stuck dreams (admin pages handle backlog there).
    const result = await this.db
      .prepare(
        `${SELECT_COLS} WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ? ORDER BY started_at ASC LIMIT ?`,
      )
      .bind(opts.staleBeforeMs, opts.limit)
      .all<DbDream>();
    return (result.results ?? []).map(toRow);
  }
}

const SELECT_COLS = `SELECT
  id, tenant_id, status,
  input_memory_store_id, input_session_ids,
  output_memory_store_id,
  model, instructions, session_id,
  usage, error,
  created_at, started_at, ended_at, archived_at
FROM dreams`;

interface DbDream {
  id: string;
  tenant_id: string;
  status: string;
  input_memory_store_id: string;
  input_session_ids: string;
  output_memory_store_id: string | null;
  model: string;
  instructions: string | null;
  session_id: string | null;
  usage: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  archived_at: number | null;
}

function toRow(r: DbDream): DreamRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    status: r.status as DreamStatus,
    input_memory_store_id: r.input_memory_store_id,
    input_session_ids: parseJsonStringArray(r.input_session_ids),
    output_memory_store_id: r.output_memory_store_id,
    model: r.model as DreamModel,
    instructions: r.instructions,
    session_id: r.session_id,
    usage: parseUsage(r.usage),
    error: parseError(r.error),
    created_at: msToIso(r.created_at),
    started_at: r.started_at ? msToIso(r.started_at) : null,
    ended_at: r.ended_at ? msToIso(r.ended_at) : null,
    archived_at: r.archived_at ? msToIso(r.archived_at) : null,
  };
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* fallthrough */
  }
  return [];
}

function parseUsage(raw: string): DreamUsage {
  try {
    const parsed = JSON.parse(raw) as Partial<DreamUsage>;
    return {
      input_tokens: int(parsed.input_tokens),
      output_tokens: int(parsed.output_tokens),
      cache_creation_input_tokens: int(parsed.cache_creation_input_tokens),
      cache_read_input_tokens: int(parsed.cache_read_input_tokens),
    };
  } catch {
    return { ...ZERO_USAGE };
  }
}

function parseError(raw: string | null): DreamError | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.type === "string" && typeof parsed.message === "string") {
      return { type: parsed.type, message: parsed.message };
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

function int(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
