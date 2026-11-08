// Node composition of the shared template cache (session-runtime
// SessionTemplateCache, design §0.0 rule 13): the template key (provider,
// image, packages, pip index, pinned ACP install, setup version), the
// builder's setup steps (environment packages + ACP install, the same
// idempotent steps a Session runs), the snapshot name, and redaction of the
// pip index from recorded errors. Lookup, expiry, backoff and the build
// lifecycle are the core's.

import { createHash, randomUUID } from "node:crypto";
import { SessionTemplateCache, type TemplateExpiry } from "@open-managed-agents/session-runtime";
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

export interface PreparedBaseLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface PreparedSandboxBasesDependencies extends TemplateExpiry {
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

type BuildRequest = PreparedBaseRequest & { builderScope: PreparedBaseScope & { builderSessionId: string }; builderSessionId: string };

/** Session sandbox creation with the template cache in front of it. */
export class PreparedSandboxBases {
  readonly #deps: PreparedSandboxBasesDependencies;
  readonly #cache: SessionTemplateCache<SandboxExecutor, SandboxPreparedBaseHandle>;

  constructor(dependencies: PreparedSandboxBasesDependencies) {
    this.#deps = dependencies;
    const pipIndexUrl = dependencies.pipIndexUrl;
    this.#cache = new SessionTemplateCache<SandboxExecutor, SandboxPreparedBaseHandle>({
      provider: dependencies.provider,
      storeFor: (workspaceId) => dependencies.kvFor(workspaceId),
      capturable: (sandbox) => supportsPreparedBase(sandbox),
      // The v1 providers keep snapshots until they expire on their side;
      // an expired entry only stops being used (design §0.0 rule 13).
      redact: (text) => redact(text, pipIndexUrl),
      logger: dependencies.logger,
      op: "main-node.prepared_base",
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      ...(dependencies.failureBackoffMs === undefined ? {} : { failureBackoffMs: dependencies.failureBackoffMs }),
      ...(dependencies.buildTimeoutMs === undefined ? {} : { buildTimeoutMs: dependencies.buildTimeoutMs }),
      ...(dependencies.disposeTimeoutMs === undefined ? {} : { disposeTimeoutMs: dependencies.disposeTimeoutMs }),
      ...(dependencies.unusedTtlMs === undefined ? {} : { unusedTtlMs: dependencies.unusedTtlMs }),
      ...(dependencies.usedTtlMs === undefined ? {} : { usedTtlMs: dependencies.usedTtlMs }),
      ...(dependencies.maxRetentionMs === undefined ? {} : { maxRetentionMs: dependencies.maxRetentionMs }),
      builder: {
        create: (scope) => {
          const s = scope as PreparedBaseScope & { builderSessionId: string };
          return dependencies.createBuilderSandbox(s.builderSessionId, {
            ...(s.workspaceId === undefined ? {} : { workspaceId: s.workspaceId }),
            ...(s.environmentId === undefined ? {} : { environmentId: s.environmentId }),
            ...(s.image === undefined ? {} : { image: s.image }),
          });
        },
        capture: async (sandbox, request, { workspaceId, key, aborted }) => {
          if (!supportsPreparedBase(sandbox)) {
            throw new Error(`SANDBOX_PROVIDER=${dependencies.provider} builder sandbox cannot capture a prepared base`);
          }
          const build = request as BuildRequest;
          const prepare = dependencies.prepareBuilder
            ?? ((target, req, id) => prepareBuilderSandbox(target, req, id, pipIndexUrl === undefined ? {} : { pipIndexUrl }));
          await prepare(sandbox, build, build.builderSessionId);
          // A setup that outlived the deadline or shutdown never captures.
          if (aborted()) throw new Error("prepared-base build was aborted before capture");
          return sandbox.capturePreparedBase({ name: preparedBaseName(workspaceId, key) });
        },
        destroy: async (sandbox) => { await sandbox.destroy?.(); },
      },
    });
  }

  dispose(): Promise<void> { return this.#cache.dispose(); }
  idle(): Promise<void> { return this.#cache.idle(); }

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
      const message = redact(error instanceof Error ? error.message : String(error), this.#deps.pipIndexUrl);
      this.#deps.logger.warn({ op: "main-node.prepared_base", path: "miss", workspaceId: scope.workspaceId, environmentId: scope.environmentId, error: message }, "Prepared sandbox base key could not be computed; creating a cold sandbox");
      return createSandbox();
    }
    const builderSessionId = `prepared_base_${randomUUID()}`;
    return this.#cache.create({
      workspaceId: scope.workspaceId,
      key,
      fields: { workspaceId: scope.workspaceId, environmentId: scope.environmentId },
      request: { ...request, builderSessionId, builderScope: { ...scope, builderSessionId } } satisfies BuildRequest,
    }, createSandbox);
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
}

/** Enabled by the composed sandbox factory: undefined (and nothing touched,
 * not even KV) unless the factory declares `capabilities.preparedBase`.
 * SANDBOX_TEMPLATE_UNUSED_TTL_MS / SANDBOX_TEMPLATE_USED_TTL_MS override the
 * two expiry windows (design §0.0 rule 13). */
export function createPreparedSandboxBases(
  sandbox: { environment: Readonly<Record<string, string | undefined>> },
  factory: Pick<SandboxFactory, "capabilities">,
  dependencies: Omit<PreparedSandboxBasesDependencies, "provider" | "defaultImage" | "pipIndexUrl">,
): PreparedSandboxBases | undefined {
  if (factory.capabilities?.preparedBase !== true) return undefined;
  const env = sandbox.environment;
  const defaultImage = env.SANDBOX_IMAGE?.trim();
  const pipIndexUrl = env.SANDBOX_PIP_INDEX_URL;
  const unusedTtlMs = ttlFromEnv("SANDBOX_TEMPLATE_UNUSED_TTL_MS", env.SANDBOX_TEMPLATE_UNUSED_TTL_MS);
  const usedTtlMs = ttlFromEnv("SANDBOX_TEMPLATE_USED_TTL_MS", env.SANDBOX_TEMPLATE_USED_TTL_MS);
  return new PreparedSandboxBases({
    ...dependencies,
    provider: env.SANDBOX_PROVIDER?.trim().toLowerCase() || "unknown",
    ...(defaultImage ? { defaultImage } : {}),
    ...(pipIndexUrl ? { pipIndexUrl } : {}),
    ...(unusedTtlMs === undefined ? {} : { unusedTtlMs }),
    ...(usedTtlMs === undefined ? {} : { usedTtlMs }),
  });
}

function ttlFromEnv(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(`${name} must be a positive integer of milliseconds, got ${JSON.stringify(value)}`);
  return ms;
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


/** Provider snapshot name: per workspace, because KV entries are. */
export function preparedBaseName(workspaceId: string, key: string): string {
  return `oma-base-${sha256(`${workspaceId}\u0000${key}`).slice(0, 32)}`;
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
