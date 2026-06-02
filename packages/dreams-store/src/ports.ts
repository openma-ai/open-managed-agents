// Abstract ports the DreamService depends on. Same DIP convention as
// memory-store / sessions-store: pure data in, pure data out, no Cloudflare
// types, no SQL dialect.
//
// Persistence is split into ONE repo (DreamRepo). Unlike memory-store there
// is no blob component — curated bytes live in the OUTPUT memory store,
// which is a regular memory_stores row managed by MemoryStoreService.

import type {
  DreamError,
  DreamModel,
  DreamRow,
  DreamStatus,
  DreamUsage,
} from "./types";

export interface NewDreamInput {
  id: string;
  tenantId: string;
  inputMemoryStoreId: string;
  inputSessionIds: string[];
  model: DreamModel;
  instructions: string | null;
  createdAt: number;
}

/**
 * Update fields for an existing dream. Every field is optional — pass only
 * what's changing. `usage` is a full replacement (caller is expected to
 * accumulate before calling), matching the way Anthropic publishes the
 * Dream resource's `usage` field as a snapshot of work-done-so-far.
 */
export interface DreamUpdateFields {
  status?: DreamStatus;
  outputMemoryStoreId?: string | null;
  sessionId?: string | null;
  usage?: DreamUsage;
  /** Pass `null` to clear; omit to leave untouched. */
  error?: DreamError | null;
  startedAt?: number | null;
  endedAt?: number | null;
}

export interface DreamListOptions {
  includeArchived: boolean;
  limit: number;
  /** Opaque pagination cursor — created_at(ms) of the last item from the
   *  previous page, plus its id for tie-break. */
  after?: { createdAtMs: number; id: string };
}

export interface DreamRepo {
  insert(input: NewDreamInput): Promise<DreamRow>;

  get(tenantId: string, dreamId: string): Promise<DreamRow | null>;

  list(
    tenantId: string,
    opts: DreamListOptions,
  ): Promise<{ items: DreamRow[]; hasMore: boolean }>;

  update(tenantId: string, dreamId: string, fields: DreamUpdateFields): Promise<DreamRow>;

  archive(tenantId: string, dreamId: string, archivedAt: number): Promise<DreamRow>;

  // ── reverse lookups (memory.ts uses these to refuse archive/delete of a
  //    store while a non-terminal dream still references it) ──────────────
  /** Non-terminal dreams that have `storeId` as their input. */
  findActiveByInputStore(tenantId: string, storeId: string): Promise<DreamRow[]>;
  /** Non-terminal dreams that have `storeId` as their output. */
  findActiveByOutputStore(tenantId: string, storeId: string): Promise<DreamRow[]>;
  /**
   * Cross-tenant lookup for the recovery sweep: dreams stuck in `running`
   * whose `started_at` is older than `staleBeforeMs`. Used by the cron to
   * re-kick orphaned pipelines after a Worker restart. Bounded by `limit`
   * so a slow shard doesn't try to recover an unbounded number of dreams
   * in one tick.
   */
  findStuckRunning(opts: {
    staleBeforeMs: number;
    limit: number;
  }): Promise<DreamRow[]>;
}

export interface Clock {
  nowMs(): number;
}

export interface IdGenerator {
  dreamId(): string;
}

export interface Logger {
  warn(msg: string, ctx?: unknown): void;
  error(msg: string, ctx?: unknown): void;
}
