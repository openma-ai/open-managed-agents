import { generateDreamId } from "@open-managed-agents/shared";
import {
  DreamInputMemoryStoreMissingError,
  DreamInputSessionMissingError,
  DreamInvalidInputError,
  DreamInvalidStateError,
  DreamNotFoundError,
} from "./errors";
import type {
  Clock,
  DreamRepo,
  DreamUpdateFields,
  IdGenerator,
  Logger,
  NewDreamInput,
} from "./ports";
import {
  DreamError,
  DreamModel,
  DreamRow,
  DreamUsage,
  MAX_DREAM_INSTRUCTIONS_CHARS,
  MAX_SESSIONS_PER_DREAM,
  SUPPORTED_DREAM_MODELS,
  ZERO_USAGE,
  isNonTerminal,
  isTerminal,
} from "./types";

export interface DreamServiceDeps {
  repo: DreamRepo;
  /** Used to validate that the input memory store exists at create time. */
  verifyMemoryStoreExists: (tenantId: string, storeId: string) => Promise<boolean>;
  /** Used to validate that every input session exists at create time. */
  verifySessionExists: (tenantId: string, sessionId: string) => Promise<boolean>;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

/**
 * DreamService — Managed Agents Dreams contract.
 *
 * Spec: https://platform.claude.com/docs/en/managed-agents/dreams
 *
 * Responsibilities:
 *   - Persistence + lifecycle (pending → running → completed | failed | canceled).
 *   - Input validation at create time (existence checks, model allowlist,
 *     instruction length, session-count cap).
 *   - Status guards (cancel only from non-terminal; archive only from
 *     terminal; idempotent terminal transitions).
 *   - Reverse-lookup queries for the memory route layer (used to refuse
 *     archive/delete of a store while it is bound to a non-terminal dream).
 *
 * Explicitly NOT responsibilities (out of scope for this service):
 *   - Running the actual curation pipeline. That lives in apps/main/src/
 *     dreams/runner.ts and calls back into this service to publish status,
 *     usage, errors, and the output store id. Splitting service ↔ runner
 *     keeps the service pure and testable; routes only ever depend on
 *     DreamService.
 *   - Provisioning the output memory store. The runner does that against
 *     MemoryStoreService and publishes the resulting id via update().
 */
export class DreamService {
  private readonly repo: DreamRepo;
  private readonly verifyMemoryStoreExists: DreamServiceDeps["verifyMemoryStoreExists"];
  private readonly verifySessionExists: DreamServiceDeps["verifySessionExists"];
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logger: Logger;

  constructor(deps: DreamServiceDeps) {
    this.repo = deps.repo;
    this.verifyMemoryStoreExists = deps.verifyMemoryStoreExists;
    this.verifySessionExists = deps.verifySessionExists;
    this.clock = deps.clock ?? defaultClock;
    this.ids = deps.ids ?? defaultIds;
    this.logger = deps.logger ?? consoleLogger;
  }

  async create(opts: {
    tenantId: string;
    inputMemoryStoreId: string;
    inputSessionIds: string[];
    model: DreamModel;
    instructions?: string | null;
  }): Promise<DreamRow> {
    if (!opts.inputMemoryStoreId) {
      throw new DreamInvalidInputError("inputs[].memory_store_id is required");
    }
    if (!SUPPORTED_DREAM_MODELS.includes(opts.model)) {
      throw new DreamInvalidInputError(
        `model must be one of: ${SUPPORTED_DREAM_MODELS.join(", ")}`,
      );
    }
    if (opts.instructions !== null && opts.instructions !== undefined) {
      if (opts.instructions.length > MAX_DREAM_INSTRUCTIONS_CHARS) {
        throw new DreamInvalidInputError(
          `instructions exceeds ${MAX_DREAM_INSTRUCTIONS_CHARS} character limit`,
        );
      }
    }
    if (opts.inputSessionIds.length > MAX_SESSIONS_PER_DREAM) {
      throw new DreamInvalidInputError(
        `sessions per dream capped at ${MAX_SESSIONS_PER_DREAM}`,
      );
    }
    // Dedupe defensively — the spec doesn't promise behavior on duplicates,
    // and a tenant passing the same id twice would skew the curator's
    // weighting. Stable-order preservation isn't a contract; first-seen wins.
    const seen = new Set<string>();
    const uniqueSessionIds: string[] = [];
    for (const sid of opts.inputSessionIds) {
      if (!sid) throw new DreamInvalidInputError("session_ids[] contains empty value");
      if (seen.has(sid)) continue;
      seen.add(sid);
      uniqueSessionIds.push(sid);
    }

    const storeExists = await this.verifyMemoryStoreExists(opts.tenantId, opts.inputMemoryStoreId);
    if (!storeExists) {
      throw new DreamInputMemoryStoreMissingError(opts.inputMemoryStoreId);
    }
    for (const sid of uniqueSessionIds) {
      const exists = await this.verifySessionExists(opts.tenantId, sid);
      if (!exists) throw new DreamInputSessionMissingError(sid);
    }

    const input: NewDreamInput = {
      id: this.ids.dreamId(),
      tenantId: opts.tenantId,
      inputMemoryStoreId: opts.inputMemoryStoreId,
      inputSessionIds: uniqueSessionIds,
      model: opts.model,
      instructions: opts.instructions ?? null,
      createdAt: this.clock.nowMs(),
    };
    return this.repo.insert(input);
  }

  async get(opts: { tenantId: string; dreamId: string }): Promise<DreamRow | null> {
    return this.repo.get(opts.tenantId, opts.dreamId);
  }

  async list(opts: {
    tenantId: string;
    includeArchived?: boolean;
    limit?: number;
    after?: { createdAtMs: number; id: string };
  }): Promise<{ items: DreamRow[]; hasMore: boolean }> {
    const limit = clampLimit(opts.limit);
    return this.repo.list(opts.tenantId, {
      includeArchived: !!opts.includeArchived,
      limit,
      after: opts.after,
    });
  }

  // ============================================================
  // Lifecycle transitions (called by the pipeline runner + routes)
  // ============================================================

  /**
   * Pending → running transition. Called by the runner once it has provisioned
   * the empty output memory store and (optionally) spawned the internal
   * pipeline session. Publishing both ids in one update keeps the dream row
   * coherent for any concurrent reader.
   */
  async markRunning(opts: {
    tenantId: string;
    dreamId: string;
    outputMemoryStoreId: string;
    sessionId: string | null;
  }): Promise<DreamRow> {
    const dream = await this.requireDream(opts);
    if (dream.status !== "pending") {
      throw new DreamInvalidStateError(
        `cannot transition to running from status ${dream.status}`,
      );
    }
    const now = this.clock.nowMs();
    return this.repo.update(opts.tenantId, opts.dreamId, {
      status: "running",
      outputMemoryStoreId: opts.outputMemoryStoreId,
      sessionId: opts.sessionId,
      startedAt: now,
    });
  }

  /** Incremental usage publish. Runner accumulates and calls this on each
   *  meaningful boundary (e.g. per LLM call). The repo stores it as a snapshot. */
  async publishUsage(opts: {
    tenantId: string;
    dreamId: string;
    usage: DreamUsage;
  }): Promise<DreamRow> {
    await this.requireDream(opts);
    return this.repo.update(opts.tenantId, opts.dreamId, { usage: opts.usage });
  }

  async markCompleted(opts: {
    tenantId: string;
    dreamId: string;
    /** Final usage snapshot. */
    usage?: DreamUsage;
  }): Promise<DreamRow> {
    const dream = await this.requireDream(opts);
    if (dream.status !== "running") {
      throw new DreamInvalidStateError(
        `cannot transition to completed from status ${dream.status}`,
      );
    }
    const now = this.clock.nowMs();
    return this.repo.update(opts.tenantId, opts.dreamId, {
      status: "completed",
      endedAt: now,
      ...(opts.usage ? { usage: opts.usage } : {}),
    });
  }

  /**
   * Mark failed from any non-terminal state. The runner uses this both for
   * pipeline crashes (caught at the top level) and for explicit policy
   * violations (input store deleted mid-run, etc.). Idempotent if already
   * failed with the same error type — the second call is a no-op.
   */
  async markFailed(opts: {
    tenantId: string;
    dreamId: string;
    error: DreamError;
    usage?: DreamUsage;
  }): Promise<DreamRow> {
    const dream = await this.requireDream(opts);
    if (isTerminal(dream.status)) {
      if (dream.status === "failed" && dream.error?.type === opts.error.type) {
        return dream;
      }
      throw new DreamInvalidStateError(
        `cannot transition to failed from terminal status ${dream.status}`,
      );
    }
    const now = this.clock.nowMs();
    return this.repo.update(opts.tenantId, opts.dreamId, {
      status: "failed",
      error: opts.error,
      endedAt: now,
      ...(opts.usage ? { usage: opts.usage } : {}),
    });
  }

  /**
   * Cancel a dream. Idempotent on `canceled`; rejects from completed/failed
   * with DreamInvalidStateError (400 in the route). The runner observes the
   * status change on its next checkpoint and unwinds. Per the spec: the
   * output store is left as-is so the caller can still inspect partial work.
   */
  async cancel(opts: { tenantId: string; dreamId: string }): Promise<DreamRow> {
    const dream = await this.requireDream(opts);
    if (dream.status === "canceled") return dream;
    if (isTerminal(dream.status)) {
      throw new DreamInvalidStateError(`cannot cancel a ${dream.status} dream`);
    }
    const now = this.clock.nowMs();
    return this.repo.update(opts.tenantId, opts.dreamId, {
      status: "canceled",
      endedAt: now,
    });
  }

  /**
   * Archive a terminal dream. Sets archived_at; leaves status untouched.
   * Idempotent on already-archived. The spec rejects archiving a pending /
   * running dream (cancel first).
   */
  async archive(opts: { tenantId: string; dreamId: string }): Promise<DreamRow> {
    const dream = await this.requireDream(opts);
    if (dream.archived_at) return dream;
    if (isNonTerminal(dream.status)) {
      throw new DreamInvalidStateError(
        `cannot archive a ${dream.status} dream; cancel it first`,
      );
    }
    return this.repo.archive(opts.tenantId, opts.dreamId, this.clock.nowMs());
  }

  // ============================================================
  // Reverse lookups for memory.ts archive/delete guard
  // ============================================================

  /**
   * Non-terminal dreams that have `storeId` as their OUTPUT memory store.
   * Used by routes/memory.ts to hard-reject archive/delete during a dream's
   * pending/running window, per the spec:
   *   "While a dream is pending or running, archiving or deleting its
   *    output store is rejected with a 400."
   *
   * Input-store disappearance is handled differently — the runner's
   * pre-flight + checkpoints translate it into `input_memory_store_unavailable`
   * on the dream itself, which is why we only block on the OUTPUT side here.
   */
  async findActiveDreamsByOutputStore(opts: {
    tenantId: string;
    storeId: string;
  }): Promise<DreamRow[]> {
    return this.repo.findActiveByOutputStore(opts.tenantId, opts.storeId);
  }

  /**
   * Cross-tenant lookup for the recovery sweep. Used by the dream
   * recovery cron to re-invoke the in-process runner against dreams
   * whose pipeline appears to have died mid-flight (Worker restart,
   * uncaught exception in the runner, OOM).
   *
   * `staleAfterMs` is the wall-clock gap between started_at and now
   * above which a running dream is considered orphaned. The runner is
   * idempotent — re-invoking it is safe; steps short-circuit on already-
   * applied state via the markRunning + markCompleted guards.
   */
  async findStuckRunning(opts: {
    staleAfterMs: number;
    limit?: number;
  }): Promise<DreamRow[]> {
    return this.repo.findStuckRunning({
      staleBeforeMs: this.clock.nowMs() - opts.staleAfterMs,
      limit: opts.limit ?? 50,
    });
  }

  /**
   * Convenience: true if any non-terminal dream references `storeId` as
   * input OR output. Currently unused by route code (memory.ts only checks
   * the output side, per the spec) but useful for future "is this store
   * busy?" admin queries and for tests asserting cleanup ordering.
   */
  async storeIsLockedByActiveDream(opts: {
    tenantId: string;
    storeId: string;
  }): Promise<{ locked: boolean; dreamIds: string[] }> {
    const [asInput, asOutput] = await Promise.all([
      this.repo.findActiveByInputStore(opts.tenantId, opts.storeId),
      this.repo.findActiveByOutputStore(opts.tenantId, opts.storeId),
    ]);
    const ids = [...asInput, ...asOutput].map((d) => d.id);
    return { locked: ids.length > 0, dreamIds: ids };
  }

  // ============================================================
  // Internals
  // ============================================================

  private async requireDream(opts: {
    tenantId: string;
    dreamId: string;
  }): Promise<DreamRow> {
    const dream = await this.repo.get(opts.tenantId, opts.dreamId);
    if (!dream) throw new DreamNotFoundError();
    return dream;
  }
}

// ============================================================
// Defaults
// ============================================================

function clampLimit(limit?: number): number {
  const fallback = 20;
  const max = 100;
  if (!limit || limit <= 0) return fallback;
  return Math.min(limit, max);
}

const defaultClock: Clock = { nowMs: () => Date.now() };
const defaultIds: IdGenerator = { dreamId: generateDreamId };
const consoleLogger: Logger = {
  warn: (m, ctx) => console.warn(m, ctx),
  error: (m, ctx) => console.error(m, ctx),
};
