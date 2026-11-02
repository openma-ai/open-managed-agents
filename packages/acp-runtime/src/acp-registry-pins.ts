/**
 * Pinned ACP registry distributions for agents OpenMA installs inside a
 * sandbox, mirroring Harbor's `acp:<id>@<version>` installed agents.
 *
 * Entries are copied verbatim from the official registry's `<id>/agent.json`
 * at the stated version. Resolution is deliberately offline: the version and
 * package are fixed in this definition, never discovered at runtime, and a
 * reference without an exact pinned version is rejected rather than floated to
 * latest. Bump an entry by copying the new upstream agent.json here.
 *
 * Browser-safe: pure data and validation, no node imports.
 */

import { MODEL_PROVIDER_SECRET_ENV_KEYS } from "@open-managed-agents/inference-proxy";

import type { OfficialRegistryAgent } from "./registry-fetch.js";

/** Provider credential env names that must never be baked into a launcher. */
const PROVIDER_SECRET_ENV_KEYS = new Set<string>([
  ...MODEL_PROVIDER_SECRET_ENV_KEYS,
  "ANTHROPIC_AUTH_TOKEN",
]);
/** Sorted provider secret env names, stripped from install-time npm calls. */
export const ACP_PROVIDER_SECRET_ENV_KEYS: readonly string[] = [...PROVIDER_SECRET_ENV_KEYS].sort();
const SHELL_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

export const PINNED_ACP_REGISTRY_AGENTS: readonly OfficialRegistryAgent[] = [
  // agentclientprotocol/registry claude-acp/agent.json, version 0.94.0.
  {
    id: "claude-acp",
    name: "Claude Agent",
    version: "0.94.0",
    description: "ACP wrapper for Anthropic's Claude",
    repository: "https://github.com/agentclientprotocol/claude-agent-acp",
    distribution: {
      npx: { package: "@agentclientprotocol/claude-agent-acp@0.94.0" },
    },
  },
];

/** The npx distribution selected for a pinned registry agent. */
export interface PinnedAcpRegistryAgent {
  readonly id: string;
  readonly version: string;
  readonly distribution: "npx";
  /** Exact `name@version` npm specifier passed to `npx -y`. */
  readonly package: string;
  readonly args: readonly string[];
  /** Non-secret registry constants only; exported by the launcher. */
  readonly env: Readonly<Record<string, string>>;
  /** Minimum Node major; matches Harbor's nvm default and the package engine. */
  readonly nodeMajor: number;
}

/** `id@version` for every pinned entry, in catalog order. */
export function pinnedAcpRegistryRefs(
  catalog: readonly OfficialRegistryAgent[] = PINNED_ACP_REGISTRY_AGENTS,
): string[] {
  return catalog.map((entry) => `${entry.id}@${entry.version}`);
}

/**
 * Save-time check for `_oma.acp.agent.registry`: the same resolution the
 * sandbox install uses, returning a readable error (with the pinned
 * references) instead of throwing. `undefined` means the reference is valid.
 */
export function acpRegistryRefError(
  ref: string,
  catalog: readonly OfficialRegistryAgent[] = PINNED_ACP_REGISTRY_AGENTS,
): string | undefined {
  try {
    resolvePinnedAcpRegistryAgent(ref, catalog);
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `${reason}; pinned ACP registry agents: ${pinnedAcpRegistryRefs(catalog).join(", ")}`;
  }
}

/** Parse `id@version` (optionally `acp:`-prefixed, as in Harbor). */
export function parseAcpRegistryRef(ref: string): { id: string; version: string } {
  const normalized = ref.trim().replace(/^acp:/, "");
  const at = normalized.lastIndexOf("@");
  const id = at > 0 ? normalized.slice(0, at) : normalized;
  const version = at > 0 ? normalized.slice(at + 1) : "";
  if (!id) throw new Error("ACP registry reference must include an agent id");
  if (!version || version === "latest" || !VERSION.test(version)) {
    throw new Error(
      `ACP registry reference "${ref}" must pin a version, for example "${id}@<version>"`,
    );
  }
  return { id, version };
}

export function resolvePinnedAcpRegistryAgent(
  ref: string,
  catalog: readonly OfficialRegistryAgent[] = PINNED_ACP_REGISTRY_AGENTS,
): PinnedAcpRegistryAgent {
  const { id, version } = parseAcpRegistryRef(ref);
  const candidates = catalog.filter((entry) => entry.id === id);
  if (candidates.length === 0) {
    throw new Error(`Unknown ACP registry agent "${id}"`);
  }
  const entry = candidates.find((candidate) => candidate.version === version);
  if (!entry) {
    const pinned = candidates.map((candidate) => `${id}@${candidate.version}`).join(", ");
    throw new Error(`ACP registry agent ${id}@${version} is not pinned; available: ${pinned}`);
  }
  const npx = entry.distribution.npx;
  if (!npx) {
    throw new Error(
      `ACP registry agent ${id}@${version} has no npx distribution; `
        + "only npx registry installs are supported in acp-sandbox",
    );
  }
  if (!npx.package.endsWith(`@${version}`)) {
    throw new Error(`ACP registry agent ${id}@${version} npx package is not pinned to ${version}`);
  }
  const env = { ...(npx.env ?? {}) };
  for (const key of Object.keys(env)) {
    if (!SHELL_ENV_KEY.test(key)) {
      throw new Error(`ACP registry agent ${id}@${version} env key "${key}" is not a shell name`);
    }
    if (PROVIDER_SECRET_ENV_KEYS.has(key)) {
      throw new Error(`ACP registry agent ${id}@${version} must not set provider secret ${key}`);
    }
  }
  return {
    id,
    version,
    distribution: "npx",
    package: npx.package,
    args: [...(npx.args ?? [])],
    env,
    nodeMajor: 22,
  };
}
