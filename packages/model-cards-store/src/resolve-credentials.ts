// Single model-credential resolution policy shared by every runtime
// composition (Node control plane, Cloudflare agent worker, Cloudflare main
// worker). There is no platform-level model key: a model call is always paid
// for with the calling workspace's own model card, the same way the
// Anthropic platform bills the organization that owns the API key.

import type { ModelCardRow } from "./types";

/** Narrow view of ModelCardService the resolver needs. */
export interface ModelCardCredentialSource {
  findByModelId(opts: { tenantId: string; modelId: string }): Promise<ModelCardRow | null>;
  getApiKey(opts: { tenantId: string; cardId: string }): Promise<string | null>;
}

export interface ResolvedWorkspaceModelCredentials {
  /** Wire-level model string sent to the provider (card.model). */
  wireModel: string;
  apiKey: string;
  /** Undefined means "use the provider catalog endpoint". */
  baseURL?: string;
  provider: string;
  customHeaders?: Record<string, string>;
  piConfig?: Record<string, unknown>;
  cardId: string;
}

/**
 * Raised when a workspace asks for a model handle it has not configured.
 * The message is user-facing: it is surfaced on session errors, failed
 * Dreams and proxy responses.
 */
export class ModelCardNotConfiguredError extends Error {
  readonly code = "model_card_not_configured";
  constructor(
    public readonly modelId: string,
    reason: "missing" | "archived" | "key_unavailable" = "missing",
  ) {
    super(
      reason === "key_unavailable"
        ? `The model card for "${modelId}" in this workspace has no usable API key. ` +
          `Re-enter the key in Console → Models.`
        : `Model "${modelId}" is not configured for this workspace. ` +
          `Add a model card with model_id "${modelId}" in Console → Models.`,
    );
    this.name = "ModelCardNotConfiguredError";
  }
}

/**
 * Resolve `modelId` (a card.model_id handle) for `tenantId` to wire model +
 * credentials. Never falls back to process or Worker environment variables;
 * a missing, archived or undecryptable card is a ModelCardNotConfiguredError.
 * Storage errors propagate unchanged.
 */
export async function resolveWorkspaceModelCredentials(
  source: ModelCardCredentialSource,
  tenantId: string,
  modelId: string,
): Promise<ResolvedWorkspaceModelCredentials> {
  const card = await source.findByModelId({ tenantId, modelId });
  if (card === null) throw new ModelCardNotConfiguredError(modelId, "missing");
  if (card.archived_at !== null) throw new ModelCardNotConfiguredError(modelId, "archived");
  const apiKey = await source.getApiKey({ tenantId, cardId: card.id });
  if (!apiKey) throw new ModelCardNotConfiguredError(modelId, "key_unavailable");
  return {
    wireModel: card.model,
    apiKey,
    baseURL: card.base_url ?? undefined,
    provider: card.provider,
    customHeaders: card.custom_headers ?? undefined,
    piConfig: card.pi_config ?? undefined,
    cardId: card.id,
  };
}
