// In-memory adapters + a convenience factory for unit tests. Mirrors the
// conventions used by memory-store/test-fakes and sessions-store/test-fakes.

import type {
  Clock,
  DreamListOptions,
  DreamRepo,
  DreamUpdateFields,
  IdGenerator,
  Logger,
  NewDreamInput,
} from "./ports";
import { DreamService, type DreamServiceDeps } from "./service";
import {
  DreamError,
  DreamRow,
  DreamUsage,
  ZERO_USAGE,
  NON_TERMINAL_STATUSES,
} from "./types";

export class InMemoryDreamRepo implements DreamRepo {
  private readonly dreams = new Map<string, DreamRow>();

  async insert(input: NewDreamInput): Promise<DreamRow> {
    const row: DreamRow = {
      id: input.id,
      tenant_id: input.tenantId,
      status: "pending",
      input_memory_store_id: input.inputMemoryStoreId,
      input_session_ids: [...input.inputSessionIds],
      output_memory_store_id: null,
      model: input.model,
      instructions: input.instructions,
      session_id: null,
      usage: { ...ZERO_USAGE },
      error: null,
      created_at: msToIso(input.createdAt),
      started_at: null,
      ended_at: null,
      archived_at: null,
    };
    this.dreams.set(input.id, row);
    return row;
  }

  async get(tenantId: string, dreamId: string): Promise<DreamRow | null> {
    const row = this.dreams.get(dreamId);
    return row && row.tenant_id === tenantId ? row : null;
  }

  async list(
    tenantId: string,
    opts: DreamListOptions,
  ): Promise<{ items: DreamRow[]; hasMore: boolean }> {
    const candidates = Array.from(this.dreams.values())
      .filter((d) => d.tenant_id === tenantId)
      .filter((d) => opts.includeArchived || !d.archived_at)
      .sort((a, b) => {
        const cmp = b.created_at.localeCompare(a.created_at);
        if (cmp !== 0) return cmp;
        return b.id.localeCompare(a.id);
      });
    let filtered = candidates;
    if (opts.after) {
      const afterIso = msToIso(opts.after.createdAtMs);
      filtered = candidates.filter((d) => {
        if (d.created_at < afterIso) return true;
        if (d.created_at === afterIso && d.id < opts.after!.id) return true;
        return false;
      });
    }
    const limited = filtered.slice(0, opts.limit + 1);
    const hasMore = limited.length > opts.limit;
    return { items: hasMore ? limited.slice(0, opts.limit) : limited, hasMore };
  }

  async update(
    tenantId: string,
    dreamId: string,
    fields: DreamUpdateFields,
  ): Promise<DreamRow> {
    const existing = await this.get(tenantId, dreamId);
    if (!existing) throw new Error(`dream ${dreamId} not found`);
    const updated: DreamRow = {
      ...existing,
      ...(fields.status !== undefined ? { status: fields.status } : {}),
      ...(fields.outputMemoryStoreId !== undefined
        ? { output_memory_store_id: fields.outputMemoryStoreId }
        : {}),
      ...(fields.sessionId !== undefined ? { session_id: fields.sessionId } : {}),
      ...(fields.usage !== undefined ? { usage: { ...fields.usage } } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.startedAt !== undefined
        ? { started_at: fields.startedAt === null ? null : msToIso(fields.startedAt) }
        : {}),
      ...(fields.endedAt !== undefined
        ? { ended_at: fields.endedAt === null ? null : msToIso(fields.endedAt) }
        : {}),
    };
    this.dreams.set(dreamId, updated);
    return updated;
  }

  async archive(tenantId: string, dreamId: string, archivedAt: number): Promise<DreamRow> {
    const existing = await this.get(tenantId, dreamId);
    if (!existing) throw new Error(`dream ${dreamId} not found`);
    const updated: DreamRow = { ...existing, archived_at: msToIso(archivedAt) };
    this.dreams.set(dreamId, updated);
    return updated;
  }

  async findActiveByInputStore(tenantId: string, storeId: string): Promise<DreamRow[]> {
    return Array.from(this.dreams.values()).filter(
      (d) =>
        d.tenant_id === tenantId &&
        d.input_memory_store_id === storeId &&
        NON_TERMINAL_STATUSES.includes(d.status),
    );
  }

  async findActiveByOutputStore(tenantId: string, storeId: string): Promise<DreamRow[]> {
    return Array.from(this.dreams.values()).filter(
      (d) =>
        d.tenant_id === tenantId &&
        d.output_memory_store_id === storeId &&
        NON_TERMINAL_STATUSES.includes(d.status),
    );
  }

  async findStuckRunning(opts: {
    staleBeforeMs: number;
    limit: number;
  }): Promise<DreamRow[]> {
    const cutoffIso = msToIso(opts.staleBeforeMs);
    return Array.from(this.dreams.values())
      .filter(
        (d) =>
          d.status === "running" &&
          d.started_at !== null &&
          d.started_at < cutoffIso,
      )
      .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""))
      .slice(0, opts.limit);
  }
}

/** Sequential ids for stable assertions across runs. */
export class SequentialDreamIdGenerator implements IdGenerator {
  private n = 0;
  dreamId(): string {
    return `drm-${++this.n}`;
  }
}

export class FixedClock implements Clock {
  constructor(private current: number = Date.UTC(2026, 0, 1)) {}
  nowMs(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  setTo(ms: number): void {
    this.current = ms;
  }
}

export class SilentLogger implements Logger {
  warn(): void {}
  error(): void {}
}

export function createInMemoryDreamService(
  opts?: Partial<DreamServiceDeps> & {
    /** Stores that exist. Defaults to "anything is valid". */
    knownMemoryStores?: Set<string>;
    /** Sessions that exist. Defaults to "anything is valid". */
    knownSessions?: Set<string>;
  },
): {
  service: DreamService;
  repo: InMemoryDreamRepo;
  clock: FixedClock;
  ids: SequentialDreamIdGenerator;
} {
  const repo = opts?.repo
    ? (opts.repo as InMemoryDreamRepo)
    : new InMemoryDreamRepo();
  const clock = (opts?.clock as FixedClock | undefined) ?? new FixedClock();
  const ids = (opts?.ids as SequentialDreamIdGenerator | undefined) ?? new SequentialDreamIdGenerator();
  const knownStores = opts?.knownMemoryStores;
  const knownSessions = opts?.knownSessions;
  const service = new DreamService({
    repo,
    clock,
    ids,
    logger: opts?.logger ?? new SilentLogger(),
    verifyMemoryStoreExists:
      opts?.verifyMemoryStoreExists ??
      (async (_t: string, id: string) => (knownStores ? knownStores.has(id) : true)),
    verifySessionExists:
      opts?.verifySessionExists ??
      (async (_t: string, id: string) => (knownSessions ? knownSessions.has(id) : true)),
  });
  return { service, repo, clock, ids };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}
