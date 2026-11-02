import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/** Unknown / non-catalog models: conservative context floor for OMA (not 128k). */
export const PI_UNKNOWN_MODEL_CONTEXT_WINDOW = 256_000;
export const PI_UNKNOWN_MODEL_MAX_TOKENS = 32_768;

/** pi-ai catalog renames — keep stored agent / model-card wire ids working. */
const PI_CATALOG_MODEL_ID_ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-flash",
};

export function resolvePiCatalogModelId(modelId: string): string {
  return PI_CATALOG_MODEL_ID_ALIASES[modelId] ?? modelId;
}

/** Lookup a built-in pi-ai catalog model by id (aliases included). */
export function findPiCatalogModel(modelId: string): Model<Api> | undefined {
  const catalogId = resolvePiCatalogModelId(modelId);
  for (const provider of builtinProviders()) {
    const match = provider.getModels().find(
      (model) => model.id === catalogId || model.id === modelId,
    );
    if (match !== undefined) return match;
  }
  return undefined;
}

export function resolvePiCatalogContextWindow(
  modelId: string,
  piConfigContextWindow?: number,
): number {
  return findPiCatalogModel(modelId)?.contextWindow
    ?? piConfigContextWindow
    ?? PI_UNKNOWN_MODEL_CONTEXT_WINDOW;
}
