import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
  type Provider,
  type ProviderHeaders,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
export { toAiSdkLanguageModel } from "./pi-ai-sdk";

export interface PiModelRuntime {
  models: Models;
  model: Model<Api>;
}

export interface PiModelCardBinding {
  /** Wire-level provider model id, not the OpenMA model-card handle. */
  model: string;
  apiKey: string;
  /** Model-card provider. Legacy ant/oai values are accepted for migration. */
  provider?: string;
  baseURL?: string;
  customHeaders?: Record<string, string>;
}

interface ProviderPlan {
  id: string;
  name: string;
  api?: Api;
  streams?: ProviderStreams;
  catalog: Provider;
}

/**
 * Compose a tenant-scoped Pi Models collection from an OpenMA model card.
 *
 * OpenMA deliberately does not implement provider request semantics here.
 * Pi owns auth application, model metadata, payloads, streaming and provider
 * compatibility. The only translation retained locally is the four legacy
 * model-card provider tags, so existing installations can migrate without
 * rewriting their stored cards.
 */
export function createPiModelRuntime(input: PiModelCardBinding): PiModelRuntime {
  const plan = resolveProviderPlan(input.provider);
  const catalogModels = plan.catalog.getModels();
  const catalogModel = catalogModels.find((model) => model.id === input.model);
  const baseUrl = input.baseURL ?? catalogModel?.baseUrl ?? plan.catalog.baseUrl;
  const api = plan.api ?? catalogModel?.api ?? inferProviderApi(plan.id, catalogModels);

  if (!baseUrl) {
    throw new Error(`Pi provider ${plan.id} does not define a base URL`);
  }

  const model: Model<Api> = catalogModel
    ? {
        ...catalogModel,
        id: input.model,
        provider: plan.id,
        api,
        baseUrl,
      }
    : {
        id: input.model,
        name: input.model,
        provider: plan.id,
        api,
        baseUrl,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // Pi requires capacity hints for custom models. These are deliberately
        // conservative fallbacks, not request/protocol behavior; a future
        // model-card metadata field can replace them without changing the Port.
        contextWindow: 128_000,
        maxTokens: 32_768,
      };

  const provider = createProvider({
    id: plan.id,
    name: plan.name,
    baseUrl,
    headers: mergeHeaders(plan.catalog.headers, input.customHeaders),
    auth: {
      apiKey: {
        name: "OpenMA model card",
        check: async () => ({ type: "api_key", source: "OpenMA model card" }),
        resolve: async () => ({
          auth: { apiKey: input.apiKey },
          source: "OpenMA model card",
        }),
      },
    },
    models: [model],
    api: plan.streams ?? delegateProviderStreams(plan.catalog),
  });

  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}

function resolveProviderPlan(provider: string | undefined): ProviderPlan {
  const requested = (provider ?? "ant").toLowerCase();
  const providers = builtinProviders();
  const getBuiltin = (id: string): Provider => {
    const match = providers.find((candidate) => candidate.id === id);
    if (!match) throw new Error(`Pi built-in provider "${id}" is unavailable`);
    return match;
  };

  switch (requested) {
    case "ant-compatible":
    case "anthropic-compatible":
      return {
        id: "anthropic-compatible",
        name: "Anthropic-compatible",
        api: "anthropic-messages",
        streams: anthropicMessagesApi(),
        catalog: getBuiltin("anthropic"),
      };
    case "oai-compatible":
    case "openai-compatible":
      return {
        id: "openai-compatible",
        name: "OpenAI-compatible",
        api: "openai-completions",
        streams: openAICompletionsApi(),
        catalog: getBuiltin("openai"),
      };
  }

  const id = requested === "ant" ? "anthropic" : requested === "oai" ? "openai" : requested;
  const catalog = getBuiltin(id);
  return { id, name: catalog.name, catalog };
}

function inferProviderApi(providerId: string, models: readonly Model<Api>[]): Api {
  const apis = new Set(models.map((model) => model.api));
  if (apis.size === 1) return apis.values().next().value as Api;
  throw new Error(
    `Model is not in Pi's ${providerId} catalog and its API cannot be inferred; `
      + "use a catalog model or a legacy compatible provider tag for a custom endpoint",
  );
}

function delegateProviderStreams(provider: Provider): ProviderStreams {
  return {
    stream: (model, context, options) => provider.stream(model, context, options),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, options),
    ...(provider.fetchDeferred
      ? {
          fetchDeferred: (model, handle, options) =>
            provider.fetchDeferred!(model, handle, options),
        }
      : {}),
    ...(provider.cancelDeferred
      ? {
          cancelDeferred: (model, handle, options) =>
            provider.cancelDeferred!(model, handle, options),
        }
      : {}),
  };
}

function mergeHeaders(
  base: ProviderHeaders | undefined,
  override: Record<string, string> | undefined,
): ProviderHeaders | undefined {
  if (!base && !override) return undefined;
  const merged = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    }
    merged[name] = value;
  }
  return merged;
}
