// Prepared sandbox bases: a provider snapshot of a clean sandbox on which the
// Environment setup (apt + pip/npm/cargo/go into /workspace) and the pinned
// ACP registry-agent install have already run.
//
// The first Session with a given setup starts cold. Once its own sandbox
// exists, a throwaway *builder* sandbox (same provider/image/scope, no
// Session inputs, vault, memory or outputs) runs exactly that base setup and
// the provider snapshots it. Later Sessions with the same setup are created
// from the snapshot, and the idempotent setup steps find themselves warm.
//
// This is a cache. It never fails or delays a Session: a failed build or a
// failed create-from-base is recorded (failed entries block rebuilds for a
// backoff) and logged, and the Session continues on a normal cold sandbox.
//
// Single builder per key: an in-process single-flight map. KvStore has no
// atomic put-if-absent, so two replicas may build the same key at once; that
// is harmless (each capture appends a build under the same snapshot name and
// the last ready entry wins) and only costs one extra builder.

import { createHash, randomUUID } from "node:crypto";
import {
  installAcpSandboxAgent,
  prepareAcpSandboxAgent,
} from "@open-managed-agents/acp-runtime/sandbox-agent";
import { resolvePinnedAcpRegistryAgent } from "@open-managed-agents/acp-runtime/registry-pins";
import type { KvStore } from "@open-managed-agents/kv-store";
import {
  hasEnvironmentPackages,
  supportsPreparedBase,
  type EnvironmentPackages,
  type SandboxExecutor,
  type SandboxFactory,
  type SandboxFactoryContext,
  type SandboxPreparedBaseHandle,
} from "@open-managed-agents/sandbox";
import { installEnvironmentPackages, type PackagedEnvironment } from "./environment-packages";

/** Bump whenever the setup scripts a base contains change (environment
 * packages script, ACP install script, marker format), so existing bases
 * are no longer matched. */
export const PREPARED_BASE_SETUP_VERSION = "2026-10-24.1";

const KEY_PREFIX = "sandbox_prepared_base:v1";
const DEFAULT_FAILURE_BACKOFF_MS = 60 * 60_000;
const DEFAULT_BUILD_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 10_000;
/** Consecutive non-"gone" create-from-base failures that count as gone. */
const HIT_FAILURES_BEFORE_GONE = 3;
const MAX_ERROR_LENGTH = 500;

export type PreparedBaseScope = Pick<SandboxFactoryContext, "environmentId" | "workspaceId" | "image">;

/** The pinned registry install the base contains (the non-secret identity). */
export interface PreparedBaseAcpInstall {
  package: string;
  version: string;
  nodeMajor: number;
}

/** What a Session asks of its sandbox's base setup. */
export interface PreparedBaseRequest {
  environment: PackagedEnvironment;
  /** Catalog image of the Session, as handed to the factory. */
  image?: { alias: string; reference: string };
  /** Pinned ACP registry reference when the Agent is `acp-sandbox`. */
  acpRegistry?: string;
}

export interface PreparedBaseKeyInput {
  provider: string;
  /** Provider default image (SANDBOX_IMAGE), used when no catalog image is selected. */
  defaultImage?: string;
  /** Catalog image; the alias counts too, since the setup markers carry it. */
  image?: { alias?: string; reference: string };
  packages?: EnvironmentPackages;
  pipIndexUrl?: string;
  acp: PreparedBaseAcpInstall | null;
  setupVersion?: string;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Content key of a prepared base, or null when there is nothing worth
 * caching (no environment packages and no pinned ACP install). Package lists
 * keep their given order: it is the order the setup installs them in.
 */
export function preparedBaseKey(input: PreparedBaseKeyInput): string | null {
  const packages = hasEnvironmentPackages(input.packages) ? input.packages! : undefined;
  if (packages === undefined && input.acp === null) return null;
  const pipIndexUrl = input.pipIndexUrl?.trim();
  return sha256(JSON.stringify({
    v: 1,
    provider: input.provider,
    image: input.image?.reference ?? input.defaultImage ?? null,
    alias: input.image?.alias ?? null,
    packages: {
      apt: [...(packages?.apt ?? [])],
      pip: [...(packages?.pip ?? [])],
      npm: [...(packages?.npm ?? [])],
      cargo: [...(packages?.cargo ?? [])],
      go: [...(packages?.go ?? [])],
    },
    pipIndexUrl: pipIndexUrl ? sha256(pipIndexUrl) : null,
    acp: input.acp === null
      ? null
      : { package: input.acp.package, version: input.acp.version, nodeMajor: input.acp.nodeMajor },
    setup: input.setupVersion ?? PREPARED_BASE_SETUP_VERSION,
  }));
}

/** The pinned install for an ACP registry reference; throws for one that is
 * not pinned (the Session itself fails on the same reference). */
export function preparedBaseAcpInstall(registry: string | undefined): PreparedBaseAcpInstall | null {
  if (registry === undefined || registry.length === 0) return null;
  const pinned = resolvePinnedAcpRegistryAgent(registry);
  return { package: pinned.package, version: pinned.version, nodeMajor: pinned.nodeMajor };
}

type PreparedBaseEntry =
  | { state: "ready"; handle: SandboxPreparedBaseHandle; createdAtMs: number }
  | { state: "failed"; error: string; failedAtMs: number };

export interface PreparedBaseLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PreparedSandboxBasesDependencies {
  /** Normalized SANDBOX_PROVIDER; part of the key and of the KV key. */
  provider: string;
  defaultImage?: string;
  pipIndexUrl?: string;
  /** KV scoped to the owning workspace (bases are not shared across tenants). */
  kvFor(workspaceId: string): KvStore;
  /** Create the builder: same factory and scope as a Session sandbox, but no
   * Session inputs, memory, outputs or vault. */
  createBuilderSandbox(sessionId: string, scope: PreparedBaseScope): Promise<SandboxExecutor>;
  logger: PreparedBaseLogger;
  clock?: { now(): number };
  failureBackoffMs?: number;
  /** Overall builder deadline (create + setup + capture); default 30 min. */
  buildTimeoutMs?: number;
  /** How long dispose() waits for builders still being created; default 10 s. */
  disposeTimeoutMs?: number;
  setupVersion?: string;
  /** Builder setup steps; defaults to the exact Session setup steps. */
  prepareBuilder?(sandbox: SandboxExecutor, request: PreparedBaseRequest, builderSessionId: string): Promise<void>;
}

/** Session sandbox creation with the prepared-base cache in front of it. */
export class PreparedSandboxBases {
  readonly #deps: PreparedSandboxBasesDependencies;
  readonly #inflight = new Map<string, Promise<void>>();
  /** When each key's last in-process build settled. */
  readonly #settled = new Map<string, number>();
  /** When each key last failed in this process. Backs up the KV failed
   * entry, so a failure is not retried per Session even if recording it in
   * KV failed too. */
  readonly #failedAt = new Map<string, number>();
  /** Aborts an in-flight build (deadline or shutdown). */
  readonly #abort = new Map<string, (error: Error) => void>();
  /** Malformed KV entries already reported, so each is logged once. */
  readonly #malformedLogged = new Set<string>();
  /** Consecutive create-from-base failures per key that the classifier did
   * not call "gone"; enough of them in a row count as gone. */
  readonly #hitFailures = new Map<string, { baseId: string; count: number }>();
  /** Builder creations still pending, including one that outlived its
   * build's deadline or shutdown. */
  readonly #steps = new Set<Promise<unknown>>();
  #disposed = false;

  constructor(dependencies: PreparedSandboxBasesDependencies) {
    this.#deps = dependencies;
  }

  /** Stop starting builds, abort in-flight ones and destroy their builders.
   * A builder still being created is waited for (bounded) and destroyed. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const abort of this.#abort.values()) abort(new BuildAborted("prepared-base build aborted by shutdown"));
    await this.idle();
    if (this.#steps.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.#steps]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, this.#deps.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);
  }

  /** Resolves when every background build started so far has settled. */
  async idle(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight.values()]);
  }

  /**
   * Create a Session sandbox: from the ready base for its setup when there is
   * one, otherwise cold (then build the base in the background).
   */
  async create(
    scope: PreparedBaseScope,
    request: PreparedBaseRequest,
    createSandbox: (preparedBase?: SandboxPreparedBaseHandle) => Promise<SandboxExecutor>,
  ): Promise<SandboxExecutor> {
    let key: string | null;
    try {
      key = this.#key(request);
    } catch (error) {
      // An unpinned ACP reference: the Session fails on it later, clearly.
      this.#deps.logger.warn({ op: "main-node.prepared_base", path: "miss", workspaceId: scope.workspaceId, environmentId: scope.environmentId, error: this.#errorText(error) }, "Prepared sandbox base key could not be computed; creating a cold sandbox");
      return createSandbox();
    }
    if (key === null || scope.workspaceId === undefined) return createSandbox();
    const kvKey = `${KEY_PREFIX}:${this.#deps.provider}:${key}`;
    // Bases are per workspace, so is every piece of in-process state.
    const local = `${scope.workspaceId}\0${kvKey}`;
    const kv = this.#deps.kvFor(scope.workspaceId);
    const startMs = this.#now();
    const fields = { op: "main-node.prepared_base", key, workspaceId: scope.workspaceId, environmentId: scope.environmentId };

    let raw: string | null;
    try {
      raw = await kv.get(kvKey);
    } catch (error) {
      // The store is unavailable: stay cold and do not build into it.
      this.#deps.logger.warn({ ...fields, path: "miss", error: this.#errorText(error) }, "Prepared sandbox base lookup failed; creating a cold sandbox");
      return createSandbox();
    }
    const entry = this.#parse(raw);
    if (entry === "malformed") {
      // Treated as a miss, so a build can overwrite it.
      if (!this.#malformedLogged.has(local)) {
        this.#malformedLogged.add(local);
        this.#deps.logger.warn({ ...fields, path: "miss", reason: "malformed_entry" }, "Prepared sandbox base entry is malformed; treating it as a miss");
      }
    }

    const failedLocally = this.#now() - (this.#failedAt.get(local) ?? -Infinity) < this.#backoffMs();
    if (entry !== null && entry !== "malformed" && entry.state === "ready" && !failedLocally) {
      try {
        const sandbox = await createSandbox(entry.handle);
        this.#hitFailures.delete(local);
        this.#deps.logger.info({ ...fields, path: "hit", baseId: entry.handle.id, durationMs: this.#now() - startMs }, "Sandbox created from prepared base");
        return sandbox;
      } catch (error) {
        const text = this.#errorText(error);
        // Counted per base: a replacement base starts from zero.
        const previous = this.#hitFailures.get(local);
        const failures = (previous?.baseId === entry.handle.id ? previous.count : 0) + 1;
        // A permanent error the classifier does not recognise (403, invalid
        // reference, …) would otherwise keep a dead base forever.
        const gone = isPreparedBaseGone(error) || failures >= HIT_FAILURES_BEFORE_GONE;
        if (gone) this.#hitFailures.delete(local);
        else this.#hitFailures.set(local, { baseId: entry.handle.id, count: failures });
        this.#failedAt.set(local, this.#now());
        this.#deps.logger.warn({ ...fields, path: "hit_failed", baseId: entry.handle.id, baseGone: gone, consecutiveFailures: failures, error: text, durationMs: this.#now() - startMs }, "Creating a sandbox from the prepared base failed; creating a cold sandbox");
        // Only a base that is gone is marked failed for every replica; a
        // transient error backs off in this process and keeps the entry.
        if (gone) {
          await this.#write(kv, kvKey, { state: "failed", error: `create_from_base_failed: ${text}`, failedAtMs: this.#now() }, fields);
        }
        return createSandbox();
      }
    }

    const backoff = failedLocally
      || (entry !== null && entry !== "malformed" && entry.state === "failed"
        && this.#now() - entry.failedAtMs < this.#backoffMs());
    const sandbox = await createSandbox();
    const capturable = supportsPreparedBase(sandbox);
    // Checked after the create: a build may have started or finished while
    // this Session read the (then empty) entry and created its sandbox.
    const building = this.#inflight.has(local) || (this.#settled.get(local) ?? -Infinity) > startMs;
    this.#deps.logger.info({
      ...fields,
      path: "miss",
      durationMs: this.#now() - startMs,
      build: backoff ? "backoff" : !capturable ? "unsupported" : building ? "in_progress" : "started",
    }, "Sandbox created without a prepared base");
    if (!backoff && capturable && !building && !this.#disposed) {
      const build = this.#build(kv, kvKey, local, key, scope, request)
        .catch(() => undefined)
        .finally(() => {
          this.#inflight.delete(local);
          this.#settled.set(local, this.#now());
        });
      // Never an unhandled rejection, whatever happens inside the build.
      void build.catch(() => undefined);
      this.#inflight.set(local, build);
    }
    return sandbox;
  }

  #key(request: PreparedBaseRequest): string | null {
    const environment = request.environment;
    const packages = environment.config.type === "cloud" ? environment.config.packages : undefined;
    return preparedBaseKey({
      provider: this.#deps.provider,
      ...(this.#deps.defaultImage === undefined ? {} : { defaultImage: this.#deps.defaultImage }),
      ...(request.image === undefined ? {} : { image: request.image }),
      ...(packages === undefined ? {} : { packages }),
      ...(this.#deps.pipIndexUrl === undefined ? {} : { pipIndexUrl: this.#deps.pipIndexUrl }),
      acp: preparedBaseAcpInstall(request.acpRegistry),
      ...(this.#deps.setupVersion === undefined ? {} : { setupVersion: this.#deps.setupVersion }),
    });
  }

  /** Never rejects: every outcome is recorded and logged, and the builder
   * is destroyed on success, failure, deadline and shutdown alike. */
  async #build(
    kv: KvStore,
    kvKey: string,
    local: string,
    key: string,
    scope: PreparedBaseScope,
    request: PreparedBaseRequest,
  ): Promise<void> {
    const startMs = this.#now();
    const builderSessionId = `prepared_base_${randomUUID()}`;
    const fields = { op: "main-node.prepared_base", key, workspaceId: scope.workspaceId, environmentId: scope.environmentId, builderSessionId };
    let builder: SandboxExecutor | undefined;
    let aborted: Error | undefined;
    let abortBuild!: (error: Error) => void;
    const abortedPromise = new Promise<never>((_, reject) => {
      abortBuild = (error) => {
        aborted ??= error;
        reject(error);
      };
    });
    void abortedPromise.catch(() => undefined);
    this.#abort.set(local, abortBuild);
    const timeoutMs = this.#deps.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    const timer = setTimeout(
      () => abortBuild(new Error(`prepared-base build exceeded its ${timeoutMs} ms deadline`)),
      timeoutMs,
    );
    const destroy = async (sandbox: SandboxExecutor) => {
      await Promise.resolve()
        .then(() => sandbox.destroy?.())
        .catch((error: unknown) => {
          this.#deps.logger.warn({ ...fields, path: "build_cleanup_failed", error: this.#errorText(error) }, "Destroying the prepared-base builder sandbox failed");
        });
    };
    // Only the builder creation can outlive the race with nothing to destroy
    // it; dispose() waits for this phase (bounded), not for the whole setup.
    let creationDone!: () => void;
    const creation = new Promise<void>((resolve) => { creationDone = resolve; });
    this.#steps.add(creation);
    void creation.finally(() => this.#steps.delete(creation));
    const steps = (async () => {
      let created: SandboxExecutor;
      try {
        created = await this.#deps.createBuilderSandbox(builderSessionId, {
          ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
          ...(scope.environmentId === undefined ? {} : { environmentId: scope.environmentId }),
          ...(scope.image === undefined ? {} : { image: scope.image }),
        });
        if (aborted !== undefined) {
          // Created after the deadline/shutdown already settled the build.
          await destroy(created);
          throw aborted;
        }
        builder = created;
      } finally {
        creationDone();
      }
      if (!supportsPreparedBase(created)) {
        throw new Error(`SANDBOX_PROVIDER=${this.#deps.provider} builder sandbox cannot capture a prepared base`);
      }
      const prepare = this.#deps.prepareBuilder
        ?? ((sandbox, req, id) => prepareBuilderSandbox(sandbox, req, id, {
          ...(this.#deps.pipIndexUrl === undefined ? {} : { pipIndexUrl: this.#deps.pipIndexUrl }),
        }));
      await prepare(created, request, builderSessionId);
      if (aborted !== undefined) throw aborted;
      return created.capturePreparedBase({ name: preparedBaseName(scope.workspaceId ?? "", key) });
    })();
    void steps.catch(() => undefined);
    try {
      const handle = await Promise.race([steps, abortedPromise]);
      await kv.put(kvKey, JSON.stringify({ state: "ready", handle, createdAtMs: this.#now() } satisfies PreparedBaseEntry));
      this.#failedAt.delete(local);
      this.#hitFailures.delete(local);
      this.#deps.logger.info({ ...fields, path: "build_ok", baseId: handle.id, durationMs: this.#now() - startMs }, "Prepared sandbox base built");
    } catch (error) {
      const text = this.#errorText(error);
      if (error instanceof BuildAborted) {
        // Shutdown is not a setup failure: nothing is recorded for other replicas.
        this.#deps.logger.warn({ ...fields, path: "build_failed", reason: "shutdown", error: text, durationMs: this.#now() - startMs }, "Prepared sandbox base build aborted by shutdown");
      } else {
        this.#failedAt.set(local, this.#now());
        this.#deps.logger.warn({ ...fields, path: "build_failed", error: text, durationMs: this.#now() - startMs }, "Building the prepared sandbox base failed");
        await this.#write(kv, kvKey, { state: "failed", error: text, failedAtMs: this.#now() }, fields);
      }
    } finally {
      clearTimeout(timer);
      this.#abort.delete(local);
      if (builder !== undefined) await destroy(builder);
    }
  }

  /** An unparsable entry, an unknown state or another provider's handle is
   * "malformed": a miss that a build may overwrite. */
  #parse(raw: string | null): PreparedBaseEntry | null | "malformed" {
    if (raw === null) return null;
    let parsed: Partial<PreparedBaseEntry>;
    try {
      parsed = JSON.parse(raw) as Partial<PreparedBaseEntry>;
    } catch {
      return "malformed";
    }
    if (typeof parsed !== "object" || parsed === null) return "malformed";
    if (parsed.state === "ready" && typeof parsed.handle?.id === "string" && parsed.handle.id.length > 0
      && parsed.handle.provider === this.#deps.provider) {
      return parsed as PreparedBaseEntry;
    }
    if (parsed.state === "failed" && typeof parsed.failedAtMs === "number") return parsed as PreparedBaseEntry;
    return "malformed";
  }

  async #write(kv: KvStore, kvKey: string, entry: PreparedBaseEntry, fields: Record<string, unknown>): Promise<void> {
    const value = entry.state === "failed"
      ? { ...entry, error: this.#redact(entry.error) }
      : entry;
    try {
      await kv.put(kvKey, JSON.stringify(value));
    } catch (error) {
      this.#deps.logger.warn({ ...fields, path: "record_failed", error: this.#errorText(error) }, "Recording the prepared sandbox base state failed");
    }
  }

  /** Redacted, then bounded: a credential is never cut in half first. */
  #redact(text: string): string {
    return redact(redact(text, this.#deps.pipIndexUrl).slice(0, MAX_ERROR_LENGTH), this.#deps.pipIndexUrl);
  }

  #errorText(error: unknown): string {
    return this.#redact(error instanceof Error ? error.message : String(error));
  }

  #backoffMs(): number {
    return this.#deps.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS;
  }

  #now(): number {
    return this.#deps.clock?.now() ?? Date.now();
  }
}

/** Enabled by the composed sandbox factory: undefined (and nothing touched,
 * not even KV) unless the factory declares `capabilities.preparedBase`. */
export function createPreparedSandboxBases(
  sandbox: { environment: Readonly<Record<string, string | undefined>> },
  factory: Pick<SandboxFactory, "capabilities">,
  dependencies: Omit<PreparedSandboxBasesDependencies, "provider" | "defaultImage" | "pipIndexUrl">,
): PreparedSandboxBases | undefined {
  if (factory.capabilities?.preparedBase !== true) return undefined;
  const env = sandbox.environment;
  const defaultImage = env.SANDBOX_IMAGE?.trim();
  const pipIndexUrl = env.SANDBOX_PIP_INDEX_URL;
  return new PreparedSandboxBases({
    ...dependencies,
    provider: env.SANDBOX_PROVIDER?.trim().toLowerCase() || "unknown",
    ...(defaultImage ? { defaultImage } : {}),
    ...(pipIndexUrl ? { pipIndexUrl } : {}),
  });
}

/** The base setup: the same idempotent steps a Session runs, nothing else. */
export async function prepareBuilderSandbox(
  sandbox: SandboxExecutor,
  request: PreparedBaseRequest,
  builderSessionId: string,
  options: { pipIndexUrl?: string } = {},
): Promise<void> {
  await installEnvironmentPackages(sandbox, request.environment, options);
  if (request.acpRegistry !== undefined && request.acpRegistry.length > 0) {
    // Same install script as the acp-sandbox harness; provider secrets are
    // stripped by it and the builder holds none to begin with.
    await installAcpSandboxAgent(sandbox, prepareAcpSandboxAgent({
      sessionId: builderSessionId,
      agent: { registry: request.acpRegistry },
    }));
  }
}

class BuildAborted extends Error {}

/** Provider snapshot name: per workspace, because KV entries are. */
export function preparedBaseName(workspaceId: string, key: string): string {
  return `oma-base-${sha256(`${workspaceId}\u0000${key}`).slice(0, 32)}`;
}

/**
 * Whether a create-from-base error says the base no longer exists, rather
 * than a transient provider problem. Deliberately small: a 404 status, a
 * not-found error class, or a message saying the snapshot/template/base is
 * not found (or a bare "404"). Anything else is treated as transient.
 */
export function isPreparedBaseGone(error: unknown): boolean {
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

/** Drop credentials an error message could echo back: the configured pip
 * index, `scheme://user:secret@` userinfo, and a userinfo-looking
 * `scheme://user:secret` with no `@` (e.g. cut by a truncation). A plain
 * `host:port` is left alone. */
function redact(text: string, pipIndexUrl: string | undefined): string {
  const index = pipIndexUrl?.trim();
  const withoutIndex = index ? text.split(index).join("<pip-index-url>") : text;
  return withoutIndex
    .replace(/(\w+:\/\/)[^\s/@]+@/g, "$1***@")
    .replace(/(\w+:\/\/)[^\s/@:]+:(?!\d+(?:[/\s]|$))[^\s/@]*(?=\s|$)/g, "$1***");
}
