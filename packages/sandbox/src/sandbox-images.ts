// Operator-curated sandbox image catalog.
//
// `SANDBOX_IMAGE` stays the process-wide default. `SANDBOX_IMAGES` lets an
// operator publish additional, pre-baked images (or provider templates)
// under stable aliases:
//
//   SANDBOX_IMAGES='{"analytics":{"reference":"registry.example/oma/analytics:2026-10","label":"Analytics","description":"pandas, polars, Claude ACP"}}'
//
// An Environment selects an image by alias only. Users never supply a raw
// provider reference, so a multi-tenant deployment cannot be made to pull an
// arbitrary image. The reference is resolved at session start and handed to
// the SandboxFactory as `ctx.image`.

export interface SandboxImageCatalogEntry {
  alias: string;
  /** Provider-specific image / template / snapshot reference. */
  reference: string;
  label?: string;
  description?: string;
}

/** Public projection: the provider reference is intentionally omitted. */
export interface SandboxImageCatalogListing {
  alias: string;
  label: string;
  description: string | null;
}

/** The image resolved for one sandbox creation. */
export interface ResolvedSandboxImage {
  alias: string;
  reference: string;
}

export interface SandboxImageCatalog {
  readonly entries: readonly SandboxImageCatalogEntry[];
  has(alias: string): boolean;
  get(alias: string): SandboxImageCatalogEntry | undefined;
  list(): SandboxImageCatalogListing[];
}

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const ENTRY_KEYS = new Set(["reference", "label", "description"]);

export class SandboxImageCatalogError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "SandboxImageCatalogError";
  }
}

/** Raised at sandbox creation when an Environment selects an alias that the
 * running deployment no longer publishes. Never falls back to the default. */
export class SandboxImageUnavailableError extends Error {
  constructor(
    readonly alias: string,
    readonly environmentId?: string,
  ) {
    super(
      `Sandbox image "${alias}" selected by environment ${environmentId ?? "(unknown)"} ` +
        "is not in this deployment's SANDBOX_IMAGES catalog. Ask the operator to restore it, " +
        "or update the environment to another image or the default image.",
    );
    this.name = "SandboxImageUnavailableError";
  }
}

export function createSandboxImageCatalog(
  entries: readonly SandboxImageCatalogEntry[] = [],
): SandboxImageCatalog {
  const byAlias = new Map(entries.map((entry) => [entry.alias, entry]));
  return {
    entries,
    has: (alias) => byAlias.has(alias),
    get: (alias) => byAlias.get(alias),
    list: () =>
      entries.map((entry) => ({
        alias: entry.alias,
        label: entry.label ?? entry.alias,
        description: entry.description ?? null,
      })),
  };
}

export const EMPTY_SANDBOX_IMAGE_CATALOG: SandboxImageCatalog = createSandboxImageCatalog();

/**
 * Parse `SANDBOX_IMAGES`. Unset or blank means an empty catalog. Any malformed
 * value throws SandboxImageCatalogError so the process fails at startup.
 */
export function parseSandboxImageCatalog(raw: string | undefined): SandboxImageCatalog {
  if (raw === undefined || raw.trim() === "") return EMPTY_SANDBOX_IMAGE_CATALOG;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SandboxImageCatalogError("SANDBOX_IMAGES must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SandboxImageCatalogError(
      'SANDBOX_IMAGES must be a JSON object of {"<alias>": {"reference": "..."}}',
    );
  }
  const entries: SandboxImageCatalogEntry[] = [];
  for (const [alias, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ALIAS_PATTERN.test(alias)) {
      throw new SandboxImageCatalogError(
        `SANDBOX_IMAGES alias "${alias}" must match ${ALIAS_PATTERN.source}`,
      );
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new SandboxImageCatalogError(`SANDBOX_IMAGES["${alias}"] must be an object`);
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!ENTRY_KEYS.has(key)) {
        throw new SandboxImageCatalogError(
          `SANDBOX_IMAGES["${alias}"] has unknown key "${key}"; allowed: reference, label, description`,
        );
      }
    }
    const { reference, label, description } = record;
    if (typeof reference !== "string" || reference.trim() === "") {
      throw new SandboxImageCatalogError(
        `SANDBOX_IMAGES["${alias}"].reference must be a non-empty string`,
      );
    }
    if (label !== undefined && typeof label !== "string") {
      throw new SandboxImageCatalogError(`SANDBOX_IMAGES["${alias}"].label must be a string`);
    }
    if (description !== undefined && typeof description !== "string") {
      throw new SandboxImageCatalogError(
        `SANDBOX_IMAGES["${alias}"].description must be a string`,
      );
    }
    entries.push({
      alias,
      reference: reference.trim(),
      ...(label !== undefined && label.trim() !== "" && { label: label.trim() }),
      ...(description !== undefined && description.trim() !== "" && {
        description: description.trim(),
      }),
    });
  }
  return createSandboxImageCatalog(entries);
}

/**
 * Resolve an Environment's selected alias. `undefined` alias means "use the
 * provider default" (`SANDBOX_IMAGE`). A selected alias missing from the
 * catalog throws SandboxImageUnavailableError.
 */
export function resolveSandboxImage(
  catalog: SandboxImageCatalog,
  alias: string | undefined,
  environmentId?: string,
): ResolvedSandboxImage | undefined {
  if (alias === undefined) return undefined;
  const entry = catalog.get(alias);
  if (entry === undefined) throw new SandboxImageUnavailableError(alias, environmentId);
  return { alias: entry.alias, reference: entry.reference };
}

/**
 * Adapters without per-session image selection call this so a selected image
 * fails loudly instead of being silently ignored.
 */
export function rejectSandboxImageSelection(
  provider: string,
  image: ResolvedSandboxImage | undefined,
): void {
  if (image === undefined) return;
  throw new Error(
    `SANDBOX_PROVIDER=${provider} does not support per-environment sandbox images ` +
      `(environment selected "${image.alias}"). Remove the image from the environment ` +
      "or use a provider that supports it (e2b, daytona, litebox, boxrun).",
  );
}
