// The template cache (research/sandbox-sdk-v2-design.md §0.0 rule 13, §0.1
// step 1), shared by every deployment. A template is a provider snapshot of
// a clean sandbox on which the Environment setup has already run; later
// Sessions with the same setup start from it.
//
// Keys come from the host (provider + image + packages + setup version) and
// are always scoped to the workspace: templates are never shared across
// tenants. Lazy build: the first Session with a setup starts cold, then a
// throwaway builder sandbox runs only that setup and is snapshotted in the
// background (session-sandbox-template-build). Never fails or delays a
// Session: a failed build or create-from-template is recorded (backoff) and
// the Session continues cold.
//
// Two-tier expiry, both configurable and capped at the provider's snapshot
// retention: a template never used expires `unusedTtlMs` after it was built
// (default 7 days); a used one `usedTtlMs` after its last use (default 14
// days, renewed on every hit, recorded at most hourly). An expired entry is
// dropped and its template discarded; the next Session rebuilds it.

import {
  buildTemplate,
  type TemplateBuildContext,
  type TemplateBuilder,
  type TemplateStore,
} from "./session-sandbox-template-build";

export type { TemplateBuilder, TemplateStore } from "./session-sandbox-template-build";

export const TEMPLATE_UNUSED_TTL_MS = 7 * 24 * 60 * 60_000;
export const TEMPLATE_USED_TTL_MS = 14 * 24 * 60 * 60_000;
/** A hit renews the used window; the store is written at most this often. */
const USAGE_RECORD_INTERVAL_MS = 60 * 60_000;
const DEFAULT_FAILURE_BACKOFF_MS = 60 * 60_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 10_000;
/** Consecutive non-"gone" create-from-template failures that count as gone. */
const HIT_FAILURES_BEFORE_GONE = 3;

/** The non-secret identity of a template (= SandboxPreparedBaseHandle). */
export interface TemplateHandle { provider: string; id: string }

export type TemplateEntry<H extends TemplateHandle> =
  | { state: "ready"; handle: H; createdAtMs: number; lastUsedAtMs?: number }
  | { state: "failed"; error: string; failedAtMs: number };

export interface TemplateLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** Deployment configuration (design §0.0 rule 13). */
export interface TemplateExpiry {
  unusedTtlMs?: number;
  usedTtlMs?: number;
  /** The provider's snapshot retention; neither TTL may exceed it. Absent = no limit known. */
  maxRetentionMs?: number;
}

export interface SessionTemplateCacheOptions<S, H extends TemplateHandle> extends TemplateExpiry {
  /** Normalized provider name; part of the store key. */
  provider: string;
  /** The store scoped to the owning workspace. */
  storeFor(workspaceId: string): TemplateStore;
  /** Creates a builder sandbox, runs only the setup on it and snapshots it. */
  builder: TemplateBuilder<S, H>;
  /** Whether a Session sandbox's provider can snapshot a template. */
  capturable(sandbox: S): boolean;
  /** Deletes an expired template; providers that cannot delete leave this out. */
  discard?(handle: H): Promise<void>;
  /** Drops secrets an error message could echo (applied before storing or logging). */
  redact?(text: string): string;
  logger: TemplateLogger;
  /** Log fields' op name. */
  op: string;
  clock?: { now(): number };
  failureBackoffMs?: number;
  buildTimeoutMs?: number;
  disposeTimeoutMs?: number;
}

/** Throws when a TTL is not a positive integer or exceeds the provider's retention. */
export function templateExpiry(expiry: TemplateExpiry): { unusedTtlMs: number; usedTtlMs: number } {
  const unusedTtlMs = expiry.unusedTtlMs ?? TEMPLATE_UNUSED_TTL_MS;
  const usedTtlMs = expiry.usedTtlMs ?? TEMPLATE_USED_TTL_MS;
  for (const [name, value] of [["unusedTtlMs", unusedTtlMs], ["usedTtlMs", usedTtlMs]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Template ${name} must be a positive integer of milliseconds, got ${value}`);
    if (expiry.maxRetentionMs !== undefined && value > expiry.maxRetentionMs) {
      throw new Error(`Template ${name} (${value} ms) exceeds the provider's snapshot retention (${expiry.maxRetentionMs} ms)`);
    }
  }
  return { unusedTtlMs, usedTtlMs };
}

/** Whether a ready entry is past its window at `nowMs`. */
export function templateExpired(entry: { createdAtMs: number; lastUsedAtMs?: number }, ttl: { unusedTtlMs: number; usedTtlMs: number }, nowMs: number): boolean {
  return entry.lastUsedAtMs === undefined
    ? nowMs - entry.createdAtMs >= ttl.unusedTtlMs
    : nowMs - entry.lastUsedAtMs >= ttl.usedTtlMs;
}

/**
 * Whether a create-from-template error says the template no longer exists
 * rather than a transient provider problem: a 404 status, a not-found error
 * class, or a message saying the snapshot/template/base is not found.
 */
export function isTemplateGone(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { status?: unknown; statusCode?: unknown; name?: unknown };
    if (candidate.status === 404 || candidate.statusCode === 404) return true;
    if (typeof candidate.name === "string" && /NotFound/.test(candidate.name)) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b404\b/.test(message)
    || /\b(snapshot|template|base)\b[^\n]{0,80}\bnot found\b/i.test(message)
    || /\bnot found\b[^\n]{0,80}\b(snapshot|template)\b/i.test(message);
}

/** Session sandbox creation with the template cache in front of it. */
export class SessionTemplateCache<S, H extends TemplateHandle> {
  static readonly KEY_PREFIX = "sandbox_prepared_base:v1";
  readonly #options: SessionTemplateCacheOptions<S, H>;
  readonly #ttl: { unusedTtlMs: number; usedTtlMs: number };
  readonly #inflight = new Map<string, Promise<void>>();
  /** When each key's last in-process build settled. */
  readonly #settled = new Map<string, number>();
  /** When each key last failed here; backs up the store's failed entry. */
  readonly #failedAt = new Map<string, number>();
  readonly #malformedLogged = new Set<string>();
  readonly #hitFailures = new Map<string, { id: string; count: number }>();
  readonly #build: TemplateBuildContext<S, H>;
  #disposed = false;

  constructor(options: SessionTemplateCacheOptions<S, H>) {
    this.#options = options;
    this.#ttl = templateExpiry(options);
    this.#build = {
      builder: options.builder,
      logger: options.logger,
      now: () => this.#now(),
      errorText: (error) => this.#errorText(error),
      write: (store, key, entry, fields) => this.#write(store, key, entry, fields),
      buildTimeoutMs: options.buildTimeoutMs,
      aborts: new Map(),
      steps: new Set(),
    };
  }

  /** Stop starting builds, abort in-flight ones and destroy their builders;
   * a builder still being created is waited for (bounded) and destroyed. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const abort of this.#build.aborts.values()) abort("shutdown");
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

  /**
   * Create a Session sandbox: from the ready template for `key` when there
   * is one, otherwise cold (then build the template in the background).
   * `key` null = nothing worth caching. `request` is what the builder sets up.
   */
  async create<R>(
    input: { workspaceId: string | undefined; key: string | null; fields: Record<string, unknown>; request: R & { builderScope: unknown } },
    createSandbox: (template?: H) => Promise<S>,
  ): Promise<S> {
    const { workspaceId, key } = input;
    if (key === null || workspaceId === undefined) return createSandbox();
    const options = this.#options;
    const storeKey = `${SessionTemplateCache.KEY_PREFIX}:${options.provider}:${key}`;
    // Templates are per workspace, so is every piece of in-process state.
    const local = `${workspaceId}\0${storeKey}`;
    const store = options.storeFor(workspaceId);
    const startMs = this.#now();
    const fields = { op: options.op, key, ...input.fields };

    let raw: string | null;
    try {
      raw = await store.get(storeKey);
    } catch (error) {
      // The store is unavailable: stay cold and do not build into it.
      options.logger.warn({ ...fields, path: "miss", error: this.#errorText(error) }, "Prepared sandbox base lookup failed; creating a cold sandbox");
      return createSandbox();
    }
    let entry = this.#parse(raw);
    if (entry === "malformed" && !this.#malformedLogged.has(local)) {
      this.#malformedLogged.add(local);
      options.logger.warn({ ...fields, path: "miss", reason: "malformed_entry" }, "Prepared sandbox base entry is malformed; treating it as a miss");
    }
    if (entry !== null && entry !== "malformed" && entry.state === "ready" && templateExpired(entry, this.#ttl, startMs)) {
      const expired = entry.handle;
      entry = null;
      options.logger.info({ ...fields, path: "expired", baseId: expired.id }, "Prepared sandbox base expired; rebuilding it");
      await this.#remove(store, storeKey, fields);
      await options.discard?.(expired).catch((error: unknown) => {
        options.logger.warn({ ...fields, path: "discard_failed", baseId: expired.id, error: this.#errorText(error) }, "Discarding the expired prepared sandbox base failed");
      });
    }

    const failedLocally = startMs - (this.#failedAt.get(local) ?? -Infinity) < this.#backoffMs();
    if (entry !== null && entry !== "malformed" && entry.state === "ready" && !failedLocally) {
      try {
        const sandbox = await createSandbox(entry.handle);
        this.#hitFailures.delete(local);
        await this.#recordUse(store, storeKey, entry, fields);
        options.logger.info({ ...fields, path: "hit", baseId: entry.handle.id, durationMs: this.#now() - startMs }, "Sandbox created from prepared base");
        return sandbox;
      } catch (error) {
        const text = this.#errorText(error);
        // Counted per template: a replacement starts from zero.
        const previous = this.#hitFailures.get(local);
        const failures = (previous?.id === entry.handle.id ? previous.count : 0) + 1;
        // A permanent error the classifier does not recognise (403, invalid
        // reference, …) would otherwise keep a dead template forever.
        const gone = isTemplateGone(error) || failures >= HIT_FAILURES_BEFORE_GONE;
        if (gone) this.#hitFailures.delete(local);
        else this.#hitFailures.set(local, { id: entry.handle.id, count: failures });
        this.#failedAt.set(local, this.#now());
        options.logger.warn({ ...fields, path: "hit_failed", baseId: entry.handle.id, baseGone: gone, consecutiveFailures: failures, error: text, durationMs: this.#now() - startMs }, "Creating a sandbox from the prepared base failed; creating a cold sandbox");
        // Only a template that is gone is marked failed for every replica.
        if (gone) await this.#write(store, storeKey, { state: "failed", error: `create_from_base_failed: ${text}`, failedAtMs: this.#now() }, fields);
        return createSandbox();
      }
    }

    const backoff = failedLocally
      || (entry !== null && entry !== "malformed" && entry.state === "failed" && this.#now() - entry.failedAtMs < this.#backoffMs());
    const sandbox = await createSandbox();
    const capturable = options.capturable(sandbox);
    // After the create: a build may have started or finished meanwhile.
    const building = this.#inflight.has(local) || (this.#settled.get(local) ?? -Infinity) > startMs;
    options.logger.info({
      ...fields,
      path: "miss",
      durationMs: this.#now() - startMs,
      build: backoff ? "backoff" : !capturable ? "unsupported" : building ? "in_progress" : "started",
    }, "Sandbox created without a prepared base");
    if (!backoff && capturable && !building && !this.#disposed) {
      const build = buildTemplate(this.#build, { store, storeKey, local, key, fields, workspaceId, request: input.request })
        .then((outcome) => {
          if (outcome === "built") { this.#failedAt.delete(local); this.#hitFailures.delete(local); }
          if (outcome === "failed") this.#failedAt.set(local, this.#now());
        })
        .catch(() => undefined)
        .finally(() => {
          this.#inflight.delete(local);
          this.#settled.set(local, this.#now());
        });
      this.#inflight.set(local, build);
    }
    return sandbox;
  }

  /** A hit renews the used window (design §0.0 rule 13), at most hourly. */
  async #recordUse(store: TemplateStore, storeKey: string, entry: Extract<TemplateEntry<H>, { state: "ready" }>, fields: Record<string, unknown>): Promise<void> {
    const now = this.#now();
    if (entry.lastUsedAtMs !== undefined && now - entry.lastUsedAtMs < USAGE_RECORD_INTERVAL_MS) return;
    await this.#write(store, storeKey, { ...entry, lastUsedAtMs: now }, fields);
  }

  /** An unparsable entry, an unknown state or another provider's handle is
   * "malformed": a miss that a build may overwrite. */
  #parse(raw: string | null): TemplateEntry<H> | null | "malformed" {
    if (raw === null) return null;
    let parsed: Partial<TemplateEntry<H>> & { handle?: Partial<H>; lastUsedAtMs?: unknown };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return "malformed";
    }
    if (typeof parsed !== "object" || parsed === null) return "malformed";
    if (parsed.state === "ready" && typeof parsed.handle?.id === "string" && parsed.handle.id.length > 0
      && parsed.handle.provider === this.#options.provider && typeof parsed.createdAtMs === "number"
      && (parsed.lastUsedAtMs === undefined || typeof parsed.lastUsedAtMs === "number")) {
      return parsed as TemplateEntry<H>;
    }
    if (parsed.state === "failed" && typeof parsed.failedAtMs === "number") return parsed as TemplateEntry<H>;
    return "malformed";
  }

  async #write(store: TemplateStore, storeKey: string, entry: TemplateEntry<H>, fields: Record<string, unknown>): Promise<void> {
    const value = entry.state === "failed" ? { ...entry, error: this.#redact(entry.error) } : entry;
    try {
      await store.put(storeKey, JSON.stringify(value));
    } catch (error) {
      this.#options.logger.warn({ ...fields, path: "record_failed", error: this.#errorText(error) }, "Recording the prepared sandbox base state failed");
    }
  }

  async #remove(store: TemplateStore, storeKey: string, fields: Record<string, unknown>): Promise<void> {
    try {
      await store.delete(storeKey);
    } catch (error) {
      this.#options.logger.warn({ ...fields, path: "record_failed", error: this.#errorText(error) }, "Removing the expired prepared sandbox base entry failed");
    }
  }

  /** Redacted, then bounded, then redacted again: a secret is never cut in half first. */
  #redact(text: string): string {
    const redact = this.#options.redact ?? ((value: string) => value);
    return redact(redact(text).slice(0, 500));
  }

  #errorText(error: unknown): string {
    return this.#redact(error instanceof Error ? error.message : String(error));
  }

  #backoffMs(): number {
    return this.#options.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS;
  }

  #now(): number {
    return this.#options.clock?.now() ?? Date.now();
  }
}
