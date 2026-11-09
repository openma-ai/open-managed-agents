// Node composition of the shared environment cache (session-runtime
// EnvironmentCache and environmentCacheKey, design §0.0 rule 13): the build
// sandbox's setup steps (the same idempotent steps a Session runs) and redaction of the
// pip index from recorded errors. Lookup, expiry and the build lifecycle are
// the core's. Only a Sandbox SDK v2 adapter that can snapshot an environment
// gets a cache.
//
// Deployed names kept on purpose: SANDBOX_TEMPLATE_UNUSED_TTL_MS and
// SANDBOX_TEMPLATE_USED_TTL_MS configure the expiry.

import {
  EnvironmentCache,
  environmentCacheKey,
  type EnvironmentCacheAcpInstall,
  type EnvironmentCacheExpiry,
  type EnvironmentCacheLogger,
  type EnvironmentCacheWarning,
  type SessionEnvironmentCache,
} from "@open-managed-agents/session-runtime";
import {
  installAcpSandboxAgent,
  prepareAcpSandboxAgent,
} from "@open-managed-agents/acp-runtime/sandbox-agent";
import { resolvePinnedAcpRegistryAgent } from "@open-managed-agents/acp-runtime/registry-pins";
import type { KvStore } from "@open-managed-agents/kv-store";
import {
  type SandboxLifecyclePort,
  type SandboxPort,
} from "@open-managed-agents/sandbox";
import { PACKAGE_HOSTS } from "@open-managed-agents/sandbox-port-kit";
import { compileFirewall, type FirewallRules } from "@open-managed-agents/sandbox-port-kit/firewall";
import { installEnvironmentPackages, type PackagedEnvironment } from "./environment-packages";

const OP = "main-node.environment_cache";

/** Where the ACP install fetches nvm and Node when the image's Node is too old. */
const ACP_INSTALL_HOSTS = ["raw.githubusercontent.com", "github.com", "nodejs.org"];

/** What a Session asks of its Environment setup. */
export interface EnvironmentCacheSetup {
  environment: PackagedEnvironment;
  /** Pinned ACP registry reference when the Agent is acp-sandbox. */
  acpRegistry?: string;
}

/** The pinned install for an ACP registry reference; throws for one that is
 * not pinned (the Session itself fails on the same reference). */
export function environmentCacheAcpInstall(registry: string | undefined): EnvironmentCacheAcpInstall | null {
  if (registry === undefined || registry.length === 0) return null;
  const pinned = resolvePinnedAcpRegistryAgent(registry);
  return { package: pinned.package, version: pinned.version, nodeMajor: pinned.nodeMajor };
}

export interface NodeEnvironmentCacheOptions extends EnvironmentCacheExpiry {
  adapter: string;
  lifecycle: SandboxLifecyclePort<SandboxPort>;
  pipIndexUrl?: string;
  /** KV scoped to the owning workspace. */
  kvFor(workspaceId: string): KvStore;
  logger: EnvironmentCacheLogger;
  clock?: { now(): number };
  buildTimeoutMs?: number;
  disposeTimeoutMs?: number;
  setupVersion?: string;
  /** Apply firewall rules to a build sandbox. */
  applyFirewall(runtime: SandboxPort, rules: FirewallRules): Promise<void>;
  /** Build sandbox setup; defaults to the exact Session setup steps. */
  setup?(runtime: SandboxPort, setup: EnvironmentCacheSetup, buildId: string): Promise<void>;
}

export class NodeEnvironmentCache {
  readonly #options: NodeEnvironmentCacheOptions;
  readonly #cache: EnvironmentCache<SandboxPort, EnvironmentCacheSetup>;

  constructor(options: NodeEnvironmentCacheOptions) {
    this.#options = options;
    const { pipIndexUrl } = options;
    this.#cache = new EnvironmentCache<SandboxPort, EnvironmentCacheSetup>({
      adapter: options.adapter,
      lifecycle: options.lifecycle,
      storeFor: (workspaceId) => {
        const kv = options.kvFor(workspaceId);
        return { retiredKeys: async (prefix, cursor, limit) => {
          const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}), limit });
          return { keys: page.keys.map(key => key.name), cursor: page.list_complete ? "" : page.cursor ?? "" };
        }, get: key => kv.get(key), put: (key, value) => kv.put(key, value), delete: key => kv.delete(key),
          compareAndSwap: (key, expected, value) => {
            if (!kv.compareAndSwap) throw new Error("Environment cache requires a strongly consistent CAS store");
            return kv.compareAndSwap(key, expected, value);
          } };
      },
      restrictEgress: (runtime, setup) => options.applyFirewall(runtime, environmentBuildFirewall(setup, pipIndexUrl)),
      setup: (runtime, setup, { buildId }) => options.setup !== undefined
        ? options.setup(runtime, setup, buildId)
        : prepareEnvironmentBuildSandbox(runtime, setup, buildId, pipIndexUrl === undefined ? {} : { pipIndexUrl }),
      redact: (text) => redact(text, pipIndexUrl),
      logger: options.logger,
      op: OP,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.buildTimeoutMs === undefined ? {} : { buildTimeoutMs: options.buildTimeoutMs }),
      ...(options.disposeTimeoutMs === undefined ? {} : { disposeTimeoutMs: options.disposeTimeoutMs }),
      ...(options.unusedTtlMs === undefined ? {} : { unusedTtlMs: options.unusedTtlMs }),
      ...(options.usedTtlMs === undefined ? {} : { usedTtlMs: options.usedTtlMs }),
      ...(options.maxRetentionMs === undefined ? {} : { maxRetentionMs: options.maxRetentionMs }),
    });
  }

  dispose(): Promise<void> { return this.#cache.dispose(); }
  idle(): Promise<void> { return this.#cache.idle(); }

  /** The core's view of the cache for one Session. */
  forSession(setup: () => EnvironmentCacheSetup | null, warn: (warning: EnvironmentCacheWarning) => void): SessionEnvironmentCache<SandboxPort> {
    return {
      acquire: async ({ scope, plan, signal }) => {
        const wanted = setup();
        return this.#cache.acquire({
          scope, plan, signal, warn,
          key: wanted === null ? null : await this.#key(wanted, plan.from, scope.workspaceId),
          setup: wanted as EnvironmentCacheSetup,
          fields: { environmentId: scope.environmentId },
        });
      },
      prepared: (scope) => this.#cache.prepared(scope),
    };
  }

  async #key(setup: EnvironmentCacheSetup, from: { image: string } | object, workspaceId: string): Promise<string | null> {
    if (!("image" in from)) return null;
    const { environment } = setup;
    const packages = environment.config.type === "cloud" ? environment.config.packages : undefined;
    let acp: EnvironmentCacheAcpInstall | null;
    try {
      acp = environmentCacheAcpInstall(setup.acpRegistry);
    } catch (error) {
      // An unpinned ACP reference: the Session fails on it later, clearly.
      this.#options.logger.warn({ op: OP, path: "miss", workspaceId, environmentId: environment.id, error: redact(error instanceof Error ? error.message : String(error), this.#options.pipIndexUrl) }, "Environment cache key could not be computed; starting from the image");
      return null;
    }
    const alias = environment.openma?.sandboxImage;
    return environmentCacheKey({
      adapter: this.#options.adapter,
      image: from.image,
      ...(alias === undefined ? {} : { imageAlias: alias }),
      ...(packages === undefined ? {} : { packages }),
      ...(this.#options.pipIndexUrl === undefined ? {} : { pipIndexUrl: this.#options.pipIndexUrl }),
      acp,
      ...(this.#options.setupVersion === undefined ? {} : { setupVersion: this.#options.setupVersion }),
    });
  }
}

/** On only for a v2 adapter that can snapshot an environment. A deployment
 * that set the expiry variables on any other path gets a warning. */
export function createNodeEnvironmentCache(
  sandbox: { environment: Readonly<Record<string, string | undefined>> },
  adapter: { name: string; lifecycle: SandboxLifecyclePort<SandboxPort>; vendor: { applyFirewall?(runtime: SandboxPort, rules: FirewallRules): Promise<void> } } | undefined,
  dependencies: Pick<NodeEnvironmentCacheOptions, "kvFor" | "logger" | "clock" | "buildTimeoutMs" | "disposeTimeoutMs" | "setupVersion" | "setup" | "maxRetentionMs">,
): NodeEnvironmentCache | undefined {
  const env = sandbox.environment;
  const unusedTtlMs = ttlFromEnv("SANDBOX_TEMPLATE_UNUSED_TTL_MS", env.SANDBOX_TEMPLATE_UNUSED_TTL_MS);
  const usedTtlMs = ttlFromEnv("SANDBOX_TEMPLATE_USED_TTL_MS", env.SANDBOX_TEMPLATE_USED_TTL_MS);
  if (adapter === undefined || adapter.lifecycle.snapshotEnvironment === undefined) {
    if (unusedTtlMs !== undefined || usedTtlMs !== undefined) {
      dependencies.logger.warn({ op: OP, path: "unsupported", adapter: adapter?.name ?? "v1" }, "SANDBOX_TEMPLATE_*_TTL_MS is set but this sandbox path has no environment cache");
    }
    return undefined;
  }
  // A build sandbox never runs with open egress (design §0.1 step 1).
  const vendor = adapter.vendor;
  if (vendor.applyFirewall === undefined) {
    dependencies.logger.warn({ op: OP, path: "unsupported", adapter: adapter.name }, "The sandbox adapter cannot restrict a build sandbox's egress; the environment cache is off");
    return undefined;
  }
  const pipIndexUrl = env.SANDBOX_PIP_INDEX_URL;
  return new NodeEnvironmentCache({
    ...dependencies,
    adapter: adapter.name,
    lifecycle: adapter.lifecycle,
    applyFirewall: (runtime, rules) => vendor.applyFirewall!(runtime, rules),
    ...(pipIndexUrl ? { pipIndexUrl } : {}),
    ...(unusedTtlMs === undefined ? {} : { unusedTtlMs }),
    ...(usedTtlMs === undefined ? {} : { usedTtlMs }),
  });
}

function ttlFromEnv(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(name + " must be a positive integer of milliseconds, got " + JSON.stringify(value));
  return ms;
}

/** A build sandbox reaches the public package sources, the deployment's pip
 * index and, for an ACP install, nvm and Node; no platform gateway, Vault or
 * Environment host. */
export function environmentBuildFirewall(setup: EnvironmentCacheSetup, pipIndexUrl: string | undefined): FirewallRules {
  const acp = setup.acpRegistry !== undefined && setup.acpRegistry.length > 0;
  return compileFirewall({
    scope: { workspaceId: "", sessionId: "", generation: 1 },
    networking: {
      type: "limited",
      hosts: [],
      packageSources: [...PACKAGE_HOSTS, ...pipIndexHost(pipIndexUrl), ...(acp ? ACP_INSTALL_HOSTS : [])],
      mcpHosts: [],
    },
    substitutions: [],
  }, { gateway: { hosts: [] }, channels: [] });
}

function pipIndexHost(pipIndexUrl: string | undefined): string[] {
  const value = pipIndexUrl?.trim();
  if (!value) return [];
  try {
    return [new URL(value).hostname];
  } catch {
    return [];
  }
}

/** The snapshot's setup: the same idempotent steps a Session runs, nothing else. */
export async function prepareEnvironmentBuildSandbox(
  sandbox: SandboxPort,
  setup: EnvironmentCacheSetup,
  buildId: string,
  options: { pipIndexUrl?: string } = {},
): Promise<void> {
  await installEnvironmentPackages(sandbox, setup.environment, options);
  if (setup.acpRegistry !== undefined && setup.acpRegistry.length > 0) {
    // Same install script as the acp-sandbox harness; provider secrets are
    // stripped by it and the build sandbox holds none to begin with.
    await installAcpSandboxAgent(sandbox, prepareAcpSandboxAgent({ sessionId: buildId, agent: { registry: setup.acpRegistry } }));
  }
}

/** Drop credentials an error message could echo back: the configured pip
 * index, scheme://user:secret@ userinfo, and a userinfo-looking
 * scheme://user:secret with no @ (e.g. cut by a truncation). A plain
 * host:port is left alone. */
export function redact(text: string, pipIndexUrl: string | undefined): string {
  const index = pipIndexUrl?.trim();
  const withoutIndex = index ? text.split(index).join("<pip-index-url>") : text;
  return withoutIndex
    .replace(/(\w+:\/\/)[^\s/@]+@/g, "$1***@")
    .replace(/(\w+:\/\/)[^\s/@:]+:(?!\d+(?:[/\s]|$))[^\s/@]*(?=\s|$)/g, "$1***");
}
