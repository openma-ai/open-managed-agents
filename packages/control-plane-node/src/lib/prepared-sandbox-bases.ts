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
  image?: { reference: string };
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

  constructor(dependencies: PreparedSandboxBasesDependencies) {
    this.#deps = dependencies;
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
      this.#deps.logger.warn({ op: "main-node.prepared_base", path: "miss", workspaceId: scope.workspaceId, environmentId: scope.environmentId, error: errorText(error) }, "Prepared sandbox base key could not be computed; creating a cold sandbox");
      return createSandbox();
    }
    if (key === null || scope.workspaceId === undefined) return createSandbox();
    const kvKey = `${KEY_PREFIX}:${this.#deps.provider}:${key}`;
    const kv = this.#deps.kvFor(scope.workspaceId);
    const startMs = this.#now();
    const fields = { op: "main-node.prepared_base", key, workspaceId: scope.workspaceId, environmentId: scope.environmentId };

    let entry: PreparedBaseEntry | null;
    try {
      entry = await this.#read(kv, kvKey);
    } catch (error) {
      this.#deps.logger.warn({ ...fields, path: "miss", err: error, error: errorText(error) }, "Prepared sandbox base lookup failed; creating a cold sandbox");
      return createSandbox();
    }

    const failedLocally = this.#now() - (this.#failedAt.get(kvKey) ?? -Infinity) < this.#backoffMs();
    if (entry?.state === "ready" && !failedLocally) {
      try {
        const sandbox = await createSandbox(entry.handle);
        this.#deps.logger.info({ ...fields, path: "hit", baseId: entry.handle.id, durationMs: this.#now() - startMs }, "Sandbox created from prepared base");
        return sandbox;
      } catch (error) {
        const text = errorText(error);
        this.#failedAt.set(kvKey, this.#now());
        this.#deps.logger.warn({ ...fields, path: "hit_failed", baseId: entry.handle.id, err: error, error: text, durationMs: this.#now() - startMs }, "Creating a sandbox from the prepared base failed; creating a cold sandbox");
        await this.#write(kv, kvKey, { state: "failed", error: `create_from_base_failed: ${text}`, failedAtMs: this.#now() }, fields);
        return createSandbox();
      }
    }

    const backoff = failedLocally
      || (entry?.state === "failed" && this.#now() - entry.failedAtMs < this.#backoffMs());
    const sandbox = await createSandbox();
    const capturable = supportsPreparedBase(sandbox);
    // Checked after the create: a build may have started or finished while
    // this Session read the (then empty) entry and created its sandbox.
    const building = this.#inflight.has(kvKey) || (this.#settled.get(kvKey) ?? -Infinity) > startMs;
    this.#deps.logger.info({
      ...fields,
      path: "miss",
      durationMs: this.#now() - startMs,
      build: backoff ? "backoff" : !capturable ? "unsupported" : building ? "in_progress" : "started",
    }, "Sandbox created without a prepared base");
    if (!backoff && capturable && !building) {
      const build = this.#build(kv, kvKey, key, scope, request)
        .finally(() => {
          this.#inflight.delete(kvKey);
          this.#settled.set(kvKey, this.#now());
        });
      this.#inflight.set(kvKey, build);
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

  /** Never rejects: every outcome is recorded and logged. */
  async #build(
    kv: KvStore,
    kvKey: string,
    key: string,
    scope: PreparedBaseScope,
    request: PreparedBaseRequest,
  ): Promise<void> {
    const startMs = this.#now();
    const builderSessionId = `prepared_base_${randomUUID()}`;
    const fields = { op: "main-node.prepared_base", key, workspaceId: scope.workspaceId, environmentId: scope.environmentId, builderSessionId };
    let builder: SandboxExecutor | undefined;
    try {
      builder = await this.#deps.createBuilderSandbox(builderSessionId, {
        ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
        ...(scope.environmentId === undefined ? {} : { environmentId: scope.environmentId }),
        ...(scope.image === undefined ? {} : { image: scope.image }),
      });
      if (!supportsPreparedBase(builder)) {
        throw new Error(`SANDBOX_PROVIDER=${this.#deps.provider} builder sandbox cannot capture a prepared base`);
      }
      const prepare = this.#deps.prepareBuilder
        ?? ((sandbox, req, id) => prepareBuilderSandbox(sandbox, req, id, {
          ...(this.#deps.pipIndexUrl === undefined ? {} : { pipIndexUrl: this.#deps.pipIndexUrl }),
        }));
      await prepare(builder, request, builderSessionId);
      const handle = await builder.capturePreparedBase({ name: `oma-base-${key.slice(0, 32)}` });
      await kv.put(kvKey, JSON.stringify({ state: "ready", handle, createdAtMs: this.#now() } satisfies PreparedBaseEntry));
      this.#failedAt.delete(kvKey);
      this.#deps.logger.info({ ...fields, path: "build_ok", baseId: handle.id, durationMs: this.#now() - startMs }, "Prepared sandbox base built");
    } catch (error) {
      const text = redact(errorText(error), this.#deps.pipIndexUrl);
      this.#failedAt.set(kvKey, this.#now());
      this.#deps.logger.warn({ ...fields, path: "build_failed", error: text, durationMs: this.#now() - startMs }, "Building the prepared sandbox base failed");
      await this.#write(kv, kvKey, { state: "failed", error: text, failedAtMs: this.#now() }, fields);
    } finally {
      await builder?.destroy?.().catch((error: unknown) => {
        this.#deps.logger.warn({ ...fields, path: "build_cleanup_failed", error: errorText(error) }, "Destroying the prepared-base builder sandbox failed");
      });
    }
  }

  async #read(kv: KvStore, kvKey: string): Promise<PreparedBaseEntry | null> {
    const raw = await kv.get(kvKey);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<PreparedBaseEntry>;
    if (parsed.state === "ready" && typeof parsed.handle?.id === "string" && parsed.handle.provider === this.#deps.provider) {
      return parsed as PreparedBaseEntry;
    }
    if (parsed.state === "failed" && typeof parsed.failedAtMs === "number") return parsed as PreparedBaseEntry;
    throw new Error(`Malformed prepared sandbox base entry ${kvKey}`);
  }

  async #write(kv: KvStore, kvKey: string, entry: PreparedBaseEntry, fields: Record<string, unknown>): Promise<void> {
    const value = entry.state === "failed"
      ? { ...entry, error: redact(entry.error, this.#deps.pipIndexUrl).slice(0, MAX_ERROR_LENGTH) }
      : entry;
    try {
      await kv.put(kvKey, JSON.stringify(value));
    } catch (error) {
      this.#deps.logger.warn({ ...fields, path: "record_failed", error: errorText(error) }, "Recording the prepared sandbox base state failed");
    }
  }

  #backoffMs(): number {
    return this.#deps.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS;
  }

  #now(): number {
    return this.#deps.clock?.now() ?? Date.now();
  }
}

/** The SANDBOX_PREPARED_BASE switch: undefined (and nothing touched, not even
 * KV) unless the operator turned the feature on. */
export function createPreparedSandboxBases(
  sandbox: { preparedBase?: boolean; environment: Readonly<Record<string, string | undefined>> },
  dependencies: Omit<PreparedSandboxBasesDependencies, "provider" | "defaultImage" | "pipIndexUrl">,
): PreparedSandboxBases | undefined {
  if (sandbox.preparedBase !== true) return undefined;
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

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
}

/** Drop credentials an error message could echo back. */
function redact(text: string, pipIndexUrl: string | undefined): string {
  const index = pipIndexUrl?.trim();
  const withoutIndex = index ? text.split(index).join("<pip-index-url>") : text;
  return withoutIndex.replace(/(\w+:\/\/)[^\s/@]+@/g, "$1***@");
}
