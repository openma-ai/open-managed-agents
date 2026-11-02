import type { InferenceProtocolEndpoint } from "@open-managed-agents/acp-runtime/inference-config";
import type { InferenceConfigAdapter } from "@open-managed-agents/acp-runtime/inference-config";
import { selectInferenceProtocol } from "@open-managed-agents/acp-runtime/inference-config";

export const PROXY = {
  proxyBaseUrl: "https://api.openma.test/v1/oma/inference-proxy/sess_1",
  proxyToken: "work-token-value",
  proxyTokenEnvVar: "HOSTED_INFERENCE_TOKEN" as const,
};

export const DEEPSEEK_ENDPOINTS: InferenceProtocolEndpoint[] = [
  {
    protocol: "openai-chat",
    proxyPathSegment: "openai/v1",
    upstreamBaseUrl: "https://api.deepseek.com",
  },
  {
    protocol: "anthropic-messages",
    proxyPathSegment: "anthropic",
    upstreamBaseUrl: "https://api.deepseek.com/anthropic",
  },
];

export const OPENAI_ENDPOINTS: InferenceProtocolEndpoint[] = [
  {
    protocol: "openai-chat",
    proxyPathSegment: "openai/v1",
    upstreamBaseUrl: "https://api.openai.com",
  },
  {
    protocol: "openai-responses",
    proxyPathSegment: "openai/v1",
    upstreamBaseUrl: "https://api.openai.com",
  },
];

export function planFor(
  adapter: InferenceConfigAdapter,
  input: {
    agent: { id: string; command: string };
    nativePath: string;
    endpoints: InferenceProtocolEndpoint[];
    wireModel: string;
    providerId: string;
  },
) {
  const { protocol, endpoint } = selectInferenceProtocol(adapter, input.endpoints);
  return adapter.plan({
    agent: input.agent,
    nativePath: input.nativePath,
    target: {
      wireModel: input.wireModel,
      providerId: input.providerId,
      protocolEndpoints: input.endpoints,
    },
    proxy: PROXY,
    protocol,
    endpoint,
  });
}

export function assertNoSecretInFiles(
  files: readonly { content: string }[],
  secret: string,
): void {
  for (const file of files) {
    if (secret.length > 0 && file.content.includes(secret)) {
      throw new Error("config file must not contain the proxy token value");
    }
  }
}
