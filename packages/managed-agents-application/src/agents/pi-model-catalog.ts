import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

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
  for (const provider of getBuiltinProviders()) {
    const match = getBuiltinModels(provider).find(
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

/** Model-card routing shared by host Pi runtime and sandbox inference projection.
 * One Pi model has one api. No sibling endpoint is inferred from a provider name.
 */
export function resolvePiModelCardRouting(input: {
  provider?: string; model: string; baseURL?: string;
  piConfig?: { api?: Api };
}): { api: Api; baseUrl: string } {
  const requested = (input.provider ?? "ant").toLowerCase();
  const compatible = ["ant-compatible", "anthropic-compatible"].includes(requested)
    ? "anthropic-messages" : ["oai-compatible", "openai-compatible"].includes(requested) ? "openai-completions" : undefined;
  const id = requested === "ant" || compatible === "anthropic-messages" ? "anthropic"
    : requested === "oai" || compatible === "openai-completions" ? "openai" : requested;
  const provider = getBuiltinProviders().find(p => p === id);
  if (!provider && !input.piConfig?.api) throw new Error(`Custom Pi provider "${id}" requires pi_config.api`);
  const models = provider ? getBuiltinModels(provider) : [];
  const model = models.find(m => m.id === resolvePiCatalogModelId(input.model)) ?? findPiCatalogModel(input.model);
  const apis = new Set(models.map(m => m.api));
  const api = input.piConfig?.api ?? compatible ?? model?.api ?? (apis.size === 1 ? apis.values().next().value : undefined);
  if (!api) throw new Error(`Model is not in Pi's ${id} catalog and its API cannot be inferred; use pi_config.api`);
  const baseUrls = new Set(models.map(m => m.baseUrl));
  const baseUrl = input.baseURL ?? model?.baseUrl ?? (baseUrls.size === 1 ? baseUrls.values().next().value : undefined);
  if (!baseUrl) throw new Error(`Pi provider ${id} does not define a base URL`);
  return { api, baseUrl };
}
