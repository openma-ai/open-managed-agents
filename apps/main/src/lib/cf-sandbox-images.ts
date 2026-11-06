// Operator SANDBOX_IMAGES catalog for the Cloudflare deployment.
//
// Same JSON object and alias/reference/label/description validation as Node
// (parseSandboxImageCatalog from @open-managed-agents/sandbox), plus two
// Cloudflare keys. A Cloudflare container class runs exactly one image that
// wrangler builds at deploy time, so an alias maps to a container binding,
// not to something pulled at session start:
//
//   SANDBOX_IMAGES='{"fix-git":{
//     "reference": "alexgshaw/fix-git:20251031",   // the source image (Harbor task.toml docker_image)
//     "binding":   "SANDBOX_FIX_GIT",              // agent worker DO binding of the container class
//     "workdir":   "/app",                         // the image WORKDIR; default /workspace
//     "label":     "fix-git"}}'
//
// `reference` stays the original image so the eval importer can match a
// Harbor task's docker_image to an alias. See docs/cloudflare-sandbox-images.md.

import {
  EMPTY_SANDBOX_IMAGE_CATALOG,
  parseSandboxImageCatalog,
  SandboxImageCatalogError,
  SandboxImageUnavailableError,
  type SandboxImageCatalog,
} from "@open-managed-agents/sandbox";

/** What the agent worker needs to place a session on a catalog image. */
export interface CfSandboxImageSelection {
  alias: string;
  binding: string;
  workdir?: string;
}

export interface CfSandboxImageCatalog extends SandboxImageCatalog {
  /** Container placement for an alias; undefined when not in the catalog. */
  placement(alias: string): CfSandboxImageSelection | undefined;
}

const CF_KEYS = ["binding", "workdir"] as const;
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const EMPTY_CF_SANDBOX_IMAGE_CATALOG: CfSandboxImageCatalog = {
  entries: EMPTY_SANDBOX_IMAGE_CATALOG.entries,
  has: EMPTY_SANDBOX_IMAGE_CATALOG.has,
  get: EMPTY_SANDBOX_IMAGE_CATALOG.get,
  list: EMPTY_SANDBOX_IMAGE_CATALOG.list,
  placement: () => undefined,
};

/**
 * Parse the Cloudflare SANDBOX_IMAGES var. Unset or blank is an empty
 * catalog. Any malformed value throws SandboxImageCatalogError.
 */
export function parseCfSandboxImageCatalog(raw: string | undefined): CfSandboxImageCatalog {
  if (raw === undefined || raw.trim() === "") return EMPTY_CF_SANDBOX_IMAGE_CATALOG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SandboxImageCatalogError("SANDBOX_IMAGES must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SandboxImageCatalogError(
      'SANDBOX_IMAGES must be a JSON object of {"<alias>": {"reference": "...", "binding": "..."}}',
    );
  }
  const shared: Record<string, unknown> = {};
  const placements = new Map<string, CfSandboxImageSelection>();
  for (const [alias, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      shared[alias] = value;
      continue;
    }
    const record = { ...(value as Record<string, unknown>) };
    const binding = record.binding;
    const workdir = record.workdir;
    for (const key of CF_KEYS) delete record[key];
    shared[alias] = record;
    if (typeof binding !== "string" || !BINDING_NAME.test(binding)) {
      throw new SandboxImageCatalogError(
        `SANDBOX_IMAGES["${alias}"].binding must name the agent worker's container Durable Object binding (e.g. "SANDBOX_FIX_GIT")`,
      );
    }
    if (workdir !== undefined && (typeof workdir !== "string" || !isAbsoluteDir(workdir))) {
      throw new SandboxImageCatalogError(
        `SANDBOX_IMAGES["${alias}"].workdir must be an absolute directory such as "/app"`,
      );
    }
    placements.set(alias, {
      alias,
      binding,
      ...(typeof workdir === "string" && { workdir: workdir.replace(/\/+$/u, "") || "/" }),
    });
  }
  // Alias pattern, reference/label/description and unknown keys: shared rules.
  const catalog = parseSandboxImageCatalog(JSON.stringify(shared));
  return {
    entries: catalog.entries,
    has: (alias) => catalog.has(alias),
    get: (alias) => catalog.get(alias),
    list: () => catalog.list(),
    placement: (alias) => placements.get(alias),
  };
}

function isAbsoluteDir(path: string): boolean {
  return path.startsWith("/") && !path.includes("\n") && !path.split("/").includes("..") && path.trim() === path;
}

const memo = new Map<string, CfSandboxImageCatalog>();

/** The catalog for a worker env, parsed once per distinct value. */
export function cfSandboxImageCatalog(env: { SANDBOX_IMAGES?: string }): CfSandboxImageCatalog {
  const raw = env.SANDBOX_IMAGES ?? "";
  let catalog = memo.get(raw);
  if (catalog === undefined) {
    catalog = parseCfSandboxImageCatalog(raw);
    memo.set(raw, catalog);
  }
  return catalog;
}

/**
 * Resolve an Environment's alias at session start. Undefined alias: the
 * default SANDBOX container. A selected alias missing from the catalog
 * throws SandboxImageUnavailableError; it never falls back to the default.
 */
export function resolveCfSandboxImage(
  catalog: CfSandboxImageCatalog,
  alias: string | undefined,
  environmentId?: string,
): CfSandboxImageSelection | undefined {
  if (alias === undefined) return undefined;
  const placement = catalog.placement(alias);
  if (placement === undefined) throw new SandboxImageUnavailableError(alias, environmentId);
  return placement;
}
