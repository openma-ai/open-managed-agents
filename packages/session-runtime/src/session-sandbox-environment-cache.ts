// The environment cache (research/sandbox-sdk-v2-design.md §0.0 rule 13, §0.1
// step 1), shared by every deployment. An environment snapshot is a disk on
// which the Environment setup has already run; later Sessions with the same
// setup start from it (1:n) instead of installing again.
//
// Keys come from the host and are scoped to the workspace: snapshots are never
// shared across tenants. The core stores, returns and compares only a ref's
// "adapter"; its "ref" belongs to the adapter.
//
//   hit        start from the snapshot, no install
//   miss       start from the image, no warning; after the Session's own
//              install succeeded a throwaway build sandbox makes the snapshot
//              in the background (never on a failed install)
//   ref gone   delete the record, warn, start from the image, rebuild
//   build fail warn; nothing is recorded, so the next Session tries again
//
// Two-tier expiry, both configurable and capped at the provider's retention:
// a snapshot never used expires "unusedTtlMs" after it was built (default 7
// days), a used one "usedTtlMs" after its last use (default 14 days, renewed
// on hits, recorded at most hourly). An expired entry and its snapshot are
// deleted; the next Session rebuilds it. A delete the provider refuses (E2B:
// sandboxes started from the snapshot still exist) keeps the ref in the
// record's "retired" list, retried on hits at most hourly and by the next
// build, so no snapshot is orphaned. Providers without a delete API skip it.

import type { Acquired, SandboxLifecyclePort, SandboxPlan } from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import {
  buildEnvironmentSnapshot,
  type EnvironmentCacheEntry,
  type EnvironmentCacheLogger,
  type EnvironmentCacheRetiredRecord,
  type EnvironmentCacheStore,
  type EnvironmentSnapshotBuildContext,
} from "./session-sandbox-environment-snapshot-build";
import type { EnvironmentSnapshotRef } from "@open-managed-agents/sandbox";

export type { EnvironmentCacheEntry, EnvironmentCacheLogger, EnvironmentCacheRetiredRecord, EnvironmentCacheStore } from "./session-sandbox-environment-snapshot-build";

export const ENVIRONMENT_CACHE_UNUSED_TTL_MS = 7 * 24 * 60 * 60_000;
export const ENVIRONMENT_CACHE_USED_TTL_MS = 14 * 24 * 60 * 60_000;
/** A hit renews the used window; the store is written at most this often. */
const USAGE_RECORD_INTERVAL_MS = 60 * 60_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 10_000;
/** Consecutive failures to start from one snapshot that count as "ref gone". */
const HIT_FAILURES_BEFORE_GONE = 3;
/** A Session that never finished its install does not keep its pending build. */
const PENDING_BUILD_MAX_AGE_MS = 60 * 60_000;
/** A stored record before validation. */
type RawRecord = { state?: unknown; snapshot?: Partial<EnvironmentSnapshotRef>; createdAtMs?: unknown; lastUsedAtMs?: unknown; retired?: unknown };

/** Retired snapshots kept per record at most (oldest dropped, logged). */
const MAX_RETIRED = 20;
/** KV key prefix: kept from the first release so deployed records stay valid. */
const KEY_PREFIX = "sandbox_prepared_base:v1";

/** A record names a different adapter than the one this deployment runs. */
export class EnvironmentSnapshotAdapterMismatchError extends Error {
  override readonly name = "EnvironmentSnapshotAdapterMismatchError";
}

export interface EnvironmentCacheWarning {
  reason: "snapshot_gone" | "snapshot_start_failed" | "snapshot_build_failed" | "cache_unavailable" | "unsupported";
  message: string;
}

/** Deployment configuration (design §0.0 rule 13). */
export interface EnvironmentCacheExpiry {
  unusedTtlMs?: number;
  usedTtlMs?: number;
  /** The provider's snapshot retention; neither TTL may exceed it. */
  maxRetentionMs?: number;
}

export interface EnvironmentCacheOptions<R, Q> extends EnvironmentCacheExpiry {
  /** The adapter's name; part of the store key and compared with each record. */
  adapter: string;
  lifecycle: SandboxLifecyclePort<R>;
  /** The store scoped to the owning workspace. */
  storeFor(workspaceId: string): EnvironmentCacheStore;
  /** Limit a build sandbox's egress to public package sources (design §0.1
   * step 1), before its setup runs. A failure fails the build, never the Session. */
  restrictEgress(runtime: R, setup: Q): Promise<void>;
  /** Run only the Environment setup on a build sandbox. */
  setup(runtime: R, setup: Q, input: { buildId: string }): Promise<void>;
  /** Drops secrets an error message could echo. */
  redact?(text: string): string;
  logger: EnvironmentCacheLogger;
  op: string;
  clock?: { now(): number };
  buildTimeoutMs?: number;
  disposeTimeoutMs?: number;
}

/** Throws when a TTL is not a positive integer or exceeds the provider's retention. */
export function environmentCacheExpiry(expiry: EnvironmentCacheExpiry): { unusedTtlMs: number; usedTtlMs: number } {
  const unusedTtlMs = expiry.unusedTtlMs ?? ENVIRONMENT_CACHE_UNUSED_TTL_MS;
  const usedTtlMs = expiry.usedTtlMs ?? ENVIRONMENT_CACHE_USED_TTL_MS;
  for (const [name, value] of [["unusedTtlMs", unusedTtlMs], ["usedTtlMs", usedTtlMs]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Environment cache " + name + " must be a positive integer of milliseconds, got " + value);
    if (expiry.maxRetentionMs !== undefined && value > expiry.maxRetentionMs) {
      throw new Error("Environment cache " + name + " (" + value + " ms) exceeds the provider's snapshot retention (" + expiry.maxRetentionMs + " ms)");
    }
  }
  return { unusedTtlMs, usedTtlMs };
}

/** Whether a record is past its window at "nowMs". */
export function environmentSnapshotExpired(entry: { createdAtMs: number; lastUsedAtMs?: number }, ttl: { unusedTtlMs: number; usedTtlMs: number }, nowMs: number): boolean {
  return entry.lastUsedAtMs === undefined
    ? nowMs - entry.createdAtMs >= ttl.unusedTtlMs
    : nowMs - entry.lastUsedAtMs >= ttl.usedTtlMs;
}

export interface EnvironmentCacheAcquire<R, Q> {
  scope: RuntimeResourceScope;
  plan: SandboxPlan;
  signal: AbortSignal;
  /** Content key of the setup, including the image digest: a snapshot of an
   * older image may still start, so a changed image must change the key.
   * null = nothing worth caching. */
  key: string | null;
  setup: Q;
  fields?: Record<string, unknown>;
  warn(warning: EnvironmentCacheWarning): void;
}

interface PendingBuild<Q> {
  atMs: number;
  store: EnvironmentCacheStore;
  storeKey: string;
  local: string;
  scope: RuntimeResourceScope;
  plan: SandboxPlan;
  setup: Q;
  fields: Record<string, unknown>;
  warn(warning: EnvironmentCacheWarning): void;
}

export class EnvironmentCache<R, Q> {
  readonly #options: EnvironmentCacheOptions<R, Q>;
  readonly #ttl: { unusedTtlMs: number; usedTtlMs: number };
  readonly #inflight = new Map<string, Promise<void>>();
  /** Sessions to tell when the in-flight build for a key fails. */
  readonly #waiters = new Map<string, Set<(warning: EnvironmentCacheWarning) => void>>();
  /** Sessions started from the image whose own install has not finished. */
  readonly #pending = new Map<string, PendingBuild<Q>>();
  readonly #malformedLogged = new Set<string>();
  readonly #hitFailures = new Map<string, { ref: string; count: number }>();
  readonly #build: EnvironmentSnapshotBuildContext<R, Q>;
  #unsupportedLogged = false;
  #disposed = false;

  constructor(options: EnvironmentCacheOptions<R, Q>) {
    this.#options = options;
    this.#ttl = environmentCacheExpiry(options);
    this.#build = {
      lifecycle: options.lifecycle,
      restrictEgress: options.restrictEgress,
      setup: options.setup,
      logger: options.logger,
      now: () => this.#now(),
      errorText: (error) => this.#errorText(error),
      buildTimeoutMs: options.buildTimeoutMs,
      aborts: new Map(),
      steps: new Set(),
      retired: async (store, storeKey) => {
        const raw = await store.get(storeKey).catch(() => null);
        return this.#retire(this.#records(raw).retired, {});
      },
    };
  }

  /** Acquire a Session sandbox: from the snapshot for its setup, else from
   * the image (and queue the build for prepared()). */
  async acquire(input: EnvironmentCacheAcquire<R, Q>): Promise<Acquired<R> | "gone"> {
    const { lifecycle, logger, op, adapter } = this.#options;
    const { scope, plan, signal, key, warn } = input;
    const cold = () => lifecycle.acquire({ scope, plan, signal });
    if (key === null || !("image" in plan.from)) return cold();
    if (lifecycle.snapshotEnvironment === undefined) {
      if (!this.#unsupportedLogged) {
        this.#unsupportedLogged = true;
        logger.warn({ op, adapter, path: "unsupported" }, "The sandbox adapter cannot snapshot an environment; the environment cache is off");
      }
      warn({ reason: "unsupported", message: "The environment cache is not available on sandbox adapter " + adapter + "; packages are installed in each Session." });
      return cold();
    }
    this.#sweepPending();
    const storeKey = KEY_PREFIX + ":" + adapter + ":" + key;
    const local = scope.workspaceId + "\0" + storeKey;
    const startMs = this.#now();
    const fields = { op, key, adapter, workspaceId: scope.workspaceId, sessionId: scope.sessionId, ...input.fields };
    const store = this.#options.storeFor(scope.workspaceId);

    let raw: string | null;
    try {
      raw = await store.get(storeKey);
    } catch (error) {
      // The store is unavailable: install in the Session and do not build into it.
      const text = this.#errorText(error);
      logger.warn({ ...fields, path: "lookup_failed", error: text }, "Environment cache lookup failed; starting from the image");
      warn({ reason: "cache_unavailable", message: "The environment cache could not be read (" + text + "); packages are installed in this Session." });
      return cold();
    }
    let { entry, retired } = this.#parse(raw, local, fields);
    if (entry !== null && environmentSnapshotExpired(entry, this.#ttl, startMs)) {
      const expired = entry.snapshot;
      entry = null;
      logger.info({ ...fields, path: "expired", snapshotRef: expired.ref }, "Environment snapshot expired; rebuilding it");
      retired = await this.#retire([...retired, expired], fields);
      await this.#keepRetired(store, storeKey, retired, fields);
    }

    let build = true;
    if (entry !== null) {
      const snapshot = entry.snapshot;
      const gone = async (detail: string) => {
        this.#hitFailures.delete(local);
        await this.#keepRetired(store, storeKey, retired, fields);
        logger.warn({ ...fields, path: "snapshot_gone", snapshotRef: snapshot.ref, detail, durationMs: this.#now() - startMs }, "The environment snapshot is no longer valid; rebuilding it");
        warn({ reason: "snapshot_gone", message: "The cached environment snapshot is no longer valid (" + detail + "); packages are installed in this Session and the cache is rebuilt." });
      };
      try {
        const acquired = await lifecycle.acquire({ scope, plan: { ...plan, from: { environmentSnapshot: snapshot } }, signal });
        if (acquired !== "gone") {
          this.#hitFailures.delete(local);
          await this.#recordUse(store, storeKey, { ...entry, ...(retired.length === 0 ? {} : { retired }) }, fields);
          logger.info({ ...fields, path: "hit", snapshotRef: snapshot.ref, durationMs: this.#now() - startMs }, "Sandbox started from the environment snapshot");
          return acquired;
        }
        await gone("the snapshot was not found");
      } catch (error) {
        if (signal.aborted) throw error;
        const text = this.#errorText(error);
        const previous = this.#hitFailures.get(local);
        const count = (previous?.ref === snapshot.ref ? previous.count : 0) + 1;
        if (count >= HIT_FAILURES_BEFORE_GONE) {
          // A permanent error that is not "not found" would keep a dead ref forever.
          await gone(count + " consecutive failures: " + text);
        } else {
          this.#hitFailures.set(local, { ref: snapshot.ref, count });
          build = false;
          logger.warn({ ...fields, path: "start_failed", snapshotRef: snapshot.ref, consecutiveFailures: count, error: text, durationMs: this.#now() - startMs }, "Starting from the environment snapshot failed; starting from the image");
          warn({ reason: "snapshot_start_failed", message: "Starting from the cached environment failed (" + text + "); packages are installed in this Session." });
        }
      }
    }

    const acquired = await cold();
    logger.info({ ...fields, path: "miss", build, durationMs: this.#now() - startMs }, "Sandbox started from the image");
    if (acquired !== "gone" && build) {
      this.#pending.set(this.#sessionKey(scope), { atMs: this.#now(), store, storeKey, local, scope, plan, setup: input.setup, fields, warn });
    }
    return acquired;
  }

  /** The Session's own setup succeeded: build its snapshot in the background.
   * Never waited on and never fails the Session. */
  prepared(scope: RuntimeResourceScope): void {
    const sessionKey = this.#sessionKey(scope);
    const pending = this.#pending.get(sessionKey);
    if (pending === undefined) return;
    this.#pending.delete(sessionKey);
    if (this.#disposed) return;
    const { local } = pending;
    const waiters = this.#waiters.get(local) ?? new Set();
    this.#waiters.set(local, waiters);
    waiters.add(pending.warn);
    if (this.#inflight.has(local)) return;
    const run = this.#runBuild(pending, waiters).catch(() => undefined).finally(() => {
      this.#inflight.delete(local);
      this.#waiters.delete(local);
    });
    this.#inflight.set(local, run);
  }

  /** Forget a Session's pending build (its setup failed). */
  abandon(scope: RuntimeResourceScope): void {
    this.#pending.delete(this.#sessionKey(scope));
  }

  /** Stop starting builds, abort in-flight ones and release their sandboxes;
   * a build sandbox still being acquired is waited for (bounded). */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#pending.clear();
    for (const abort of this.#build.aborts.values()) abort();
    await this.idle();
    if (this.#build.steps.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.#build.steps]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, this.#options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  /** Resolves when every background build started so far has settled. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight.values()]);
  }

  async #runBuild(pending: PendingBuild<Q>, waiters: Set<(warning: EnvironmentCacheWarning) => void>): Promise<void> {
    const { store, storeKey, local, fields } = pending;
    // Another replica or Session may have finished one meanwhile.
    const current = await store.get(storeKey).catch(() => null);
    const { entry: existing } = this.#parse(current, local, fields);
    if (existing !== null && !environmentSnapshotExpired(existing, this.#ttl, this.#now())) return;
    const result = await buildEnvironmentSnapshot(this.#build, { store, storeKey, local, fields, scope: pending.scope, plan: pending.plan, setup: pending.setup });
    if (result.outcome === "built") this.#hitFailures.delete(local);
    if (result.outcome !== "failed") return;
    for (const warn of waiters) {
      warn({ reason: "snapshot_build_failed", message: "Building the environment cache failed (" + result.error + "); this Session is unaffected and the next Session tries again." });
    }
  }

  async #recordUse(store: EnvironmentCacheStore, storeKey: string, entry: EnvironmentCacheEntry, fields: Record<string, unknown>): Promise<void> {
    const now = this.#now();
    if (entry.lastUsedAtMs !== undefined && now - entry.lastUsedAtMs < USAGE_RECORD_INTERVAL_MS) return;
    const { retired: previous, ...rest } = entry;
    const retired = await this.#retire(previous ?? [], fields);
    try {
      await store.put(storeKey, JSON.stringify({ ...rest, lastUsedAtMs: now, ...(retired.length === 0 ? {} : { retired }) } satisfies EnvironmentCacheEntry));
    } catch (error) {
      this.#options.logger.warn({ ...fields, path: "record_failed", error: this.#errorText(error) }, "Recording the environment snapshot's use failed");
    }
  }

  /** Delete each retired snapshot; returns those still to delete (newest kept). */
  async #retire(refs: EnvironmentSnapshotRef[], fields: Record<string, unknown>): Promise<EnvironmentSnapshotRef[]> {
    const remove = this.#options.lifecycle.deleteEnvironmentSnapshot;
    if (remove === undefined || refs.length === 0) return [];
    const kept: EnvironmentSnapshotRef[] = [];
    for (const ref of refs) {
      try {
        await remove.call(this.#options.lifecycle, { ref });
      } catch (error) {
        kept.push(ref);
        this.#options.logger.warn({ ...fields, path: "delete_failed", snapshotRef: ref.ref, error: this.#errorText(error) }, "Deleting a retired environment snapshot failed; it is retried later");
      }
    }
    if (kept.length > MAX_RETIRED) {
      this.#options.logger.warn({ ...fields, path: "retired_dropped", dropped: kept.slice(0, kept.length - MAX_RETIRED).map((ref) => ref.ref) }, "Too many retired environment snapshots; the oldest are no longer retried");
    }
    return kept.slice(-MAX_RETIRED);
  }

  /** The record without a usable snapshot: kept for its retired ones, else removed. */
  async #keepRetired(store: EnvironmentCacheStore, storeKey: string, retired: EnvironmentSnapshotRef[], fields: Record<string, unknown>): Promise<void> {
    if (retired.length === 0) return this.#remove(store, storeKey, fields);
    try {
      await store.put(storeKey, JSON.stringify({ state: "retired", retired } satisfies EnvironmentCacheRetiredRecord));
    } catch (error) {
      this.#options.logger.warn({ ...fields, path: "record_failed", error: this.#errorText(error) }, "Recording the retired environment snapshots failed");
    }
  }

  async #remove(store: EnvironmentCacheStore, storeKey: string, fields: Record<string, unknown>): Promise<void> {
    try {
      await store.delete(storeKey);
    } catch (error) {
      this.#options.logger.warn({ ...fields, path: "record_failed", error: this.#errorText(error) }, "Removing the environment cache record failed");
    }
  }

  /** entry null = a miss (absent, unparsable, an older record shape or a
   * retired-only record). A ready record of another adapter is an error: its
   * ref means nothing here, and rebuilding over it would hide a misconfigured
   * deployment. */
  #parse(raw: string | null, local: string, fields: Record<string, unknown>): { entry: EnvironmentCacheEntry | null; retired: EnvironmentSnapshotRef[] } {
    if (raw === null) return { entry: null, retired: [] };
    const { parsed, retired } = this.#records(raw);
    if (parsed?.state === "retired" && retired.length > 0) return { entry: null, retired };
    const snapshot = parsed?.snapshot;
    if (parsed === null || parsed.state !== "ready"
      || typeof snapshot?.adapter !== "string" || typeof snapshot.ref !== "string" || snapshot.ref.length === 0
      || typeof parsed.createdAtMs !== "number"
      || (parsed.lastUsedAtMs !== undefined && typeof parsed.lastUsedAtMs !== "number")) {
      if (!this.#malformedLogged.has(local)) {
        this.#malformedLogged.add(local);
        this.#options.logger.warn({ ...fields, path: "miss", reason: "malformed_entry" }, "Environment cache record is malformed; treating it as a miss");
      }
      return { entry: null, retired };
    }
    if (snapshot.adapter !== this.#options.adapter) {
      throw new EnvironmentSnapshotAdapterMismatchError("Environment cache record belongs to sandbox adapter " + snapshot.adapter + ", but this deployment runs " + this.#options.adapter);
    }
    const { retired: _retired, ...entry } = parsed as unknown as EnvironmentCacheEntry;
    return { entry: entry as EnvironmentCacheEntry, retired };
  }

  /** The raw record and its retired refs of this adapter (others are not ours to delete). */
  #records(raw: string | null): { parsed: RawRecord | null; retired: EnvironmentSnapshotRef[] } {
    let parsed: RawRecord | null = null;
    try {
      const value: unknown = raw === null ? null : JSON.parse(raw);
      if (typeof value === "object" && value !== null) parsed = value as RawRecord;
    } catch { /* malformed */ }
    const list: unknown[] = Array.isArray(parsed?.retired) ? parsed.retired : [];
    const retired = list.filter((ref): ref is EnvironmentSnapshotRef => {
      const candidate = ref as Partial<EnvironmentSnapshotRef> | null;
      return typeof candidate === "object" && candidate !== null && candidate.adapter === this.#options.adapter
        && typeof candidate.ref === "string" && candidate.ref.length > 0;
    });
    return { parsed, retired };
  }

  #sweepPending(): void {
    const cutoff = this.#now() - PENDING_BUILD_MAX_AGE_MS;
    for (const [key, pending] of this.#pending) if (pending.atMs < cutoff) this.#pending.delete(key);
  }

  #sessionKey(scope: RuntimeResourceScope): string {
    return scope.workspaceId + "\0" + scope.sessionId;
  }

  /** Redacted, then bounded, then redacted again: a secret is never cut in half first. */
  #errorText(error: unknown): string {
    const redact = this.#options.redact ?? ((value: string) => value);
    return redact(redact(error instanceof Error ? error.message : String(error)).slice(0, 500));
  }

  #now(): number {
    return this.#options.clock?.now() ?? Date.now();
  }
}
