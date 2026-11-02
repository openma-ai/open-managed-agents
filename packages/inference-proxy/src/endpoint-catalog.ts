import type { InferenceProtocolEndpoint, InferenceWireProtocol } from "./protocol-types.js";
import { INFERENCE_PROTOCOL_PROXY_PATH } from "./protocol-types.js";

export interface ModelCardInferenceFields {
  providerId: string;
  baseUrl: string | null;
  protocolEndpoints?: readonly InferenceProtocolEndpoint[];
}

interface InferenceEndpointContributor {
  readonly providerIds: readonly string[];
  endpoints(input: {
    providerId: string;
    baseUrl: string | null;
  }): readonly InferenceProtocolEndpoint[];
}

function endpoint(
  protocol: InferenceWireProtocol,
  upstreamBaseUrl: string,
): InferenceProtocolEndpoint {
  return {
    protocol,
    proxyPathSegment: INFERENCE_PROTOCOL_PROXY_PATH[protocol],
    upstreamBaseUrl: upstreamBaseUrl.replace(/\/$/, ""),
  };
}

export const DEFAULT_INFERENCE_ENDPOINT_CONTRIBUTORS: readonly InferenceEndpointContributor[] = [
  {
    providerIds: ["deepseek"],
    endpoints: ({ baseUrl }) => baseUrl == null ? [
      endpoint("openai-chat", "https://api.deepseek.com"),
      endpoint("anthropic-messages", "https://api.deepseek.com/anthropic"),
    ] : [
      // A configured DeepSeek base denotes its OpenAI-compatible endpoint.
      // Do not infer an Anthropic sibling (or send its key to the public API).
      // Deployments with both protocols must supply explicit protocolEndpoints.
      endpoint("openai-chat", baseUrl),
    ],
  },
  {
    providerIds: ["anthropic", "ant", "ant-compatible"],
    endpoints: ({ baseUrl }) => [
      endpoint(
        "anthropic-messages",
        baseUrl?.replace(/\/v1\/?$/, "") ?? "https://api.anthropic.com",
      ),
    ],
  },
  {
    providerIds: ["openai", "oai", "oai-compatible"],
    endpoints: ({ baseUrl }) => {
      const root = baseUrl?.replace(/\/v1\/?$/, "") ?? "https://api.openai.com";
      return [
        endpoint("openai-chat", root),
        endpoint("openai-responses", root),
      ];
    },
  },
  {
    providerIds: ["google", "gemini"],
    endpoints: ({ baseUrl }) => [
      endpoint(
        "gemini",
        baseUrl?.replace(/\/$/, "") ?? "https://generativelanguage.googleapis.com",
      ),
    ],
  },
];

const contributorIndex = new Map<string, InferenceEndpointContributor>();
for (const contributor of DEFAULT_INFERENCE_ENDPOINT_CONTRIBUTORS) {
  for (const id of contributor.providerIds) {
    contributorIndex.set(id.trim().toLowerCase(), contributor);
  }
}

export function resolveProtocolEndpointsFromModelCard(
  fields: ModelCardInferenceFields,
): readonly InferenceProtocolEndpoint[] {
  if (fields.protocolEndpoints && fields.protocolEndpoints.length > 0) {
    return fields.protocolEndpoints;
  }
  const contributor = contributorIndex.get(fields.providerId.trim().toLowerCase());
  if (!contributor) {
    return [];
  }
  return contributor.endpoints({
    providerId: fields.providerId,
    baseUrl: fields.baseUrl,
  });
}
