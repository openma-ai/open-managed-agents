import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Models,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

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
  api: Api;
  streams: ProviderStreams;
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
  const catalogModel = plan.catalog.getModels().find((model) => model.id === input.model);
  const baseUrl = input.baseURL ?? catalogModel?.baseUrl ?? plan.catalog.baseUrl;

  if (!baseUrl) {
    throw new Error(`Pi provider ${plan.id} does not define a base URL`);
  }

  const model: Model<Api> = catalogModel
    ? {
        ...catalogModel,
        id: input.model,
        provider: plan.id,
        api: plan.api,
        baseUrl,
      }
    : {
        id: input.model,
        name: input.model,
        provider: plan.id,
        api: plan.api,
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
    headers: input.customHeaders,
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
    api: plan.streams,
  });

  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}

function resolveProviderPlan(provider: string | undefined): ProviderPlan {
  switch ((provider ?? "ant").toLowerCase()) {
    case "ant":
    case "anthropic":
      return {
        id: "anthropic",
        name: "Anthropic",
        api: "anthropic-messages",
        streams: anthropicMessagesApi(),
        catalog: anthropicProvider(),
      };
    case "ant-compatible":
    case "anthropic-compatible":
      return {
        id: "anthropic-compatible",
        name: "Anthropic-compatible",
        api: "anthropic-messages",
        streams: anthropicMessagesApi(),
        catalog: anthropicProvider(),
      };
    case "oai":
    case "openai":
      return {
        id: "openai",
        name: "OpenAI",
        api: "openai-responses",
        streams: openAIResponsesApi(),
        catalog: openaiProvider(),
      };
    case "oai-compatible":
    case "openai-compatible":
      return {
        id: "openai-compatible",
        name: "OpenAI-compatible",
        api: "openai-completions",
        streams: openAICompletionsApi(),
        catalog: openaiProvider(),
      };
    case "deepseek":
      return {
        id: "deepseek",
        name: "DeepSeek",
        api: "openai-completions",
        streams: openAICompletionsApi(),
        catalog: deepseekProvider(),
      };
    default:
      throw new Error(
        `Unsupported model-card provider "${provider}". Use a Pi provider id supported by the model-card adapter.`,
      );
  }
}
