import type { InferenceConfigAdapter } from "@open-managed-agents/acp-runtime/inference-config";
import { join } from "node:path";

import { matchesAgentIdentity } from "../match.js";
import { proxyUrl } from "../helpers.js";

export const kimiCodeInferenceAdapter: InferenceConfigAdapter = {
  id: "kimi-code",
  supportedProtocols: ["anthropic-messages", "openai-responses", "gemini", "openai-chat"],
  matches: (agent) => matchesAgentIdentity(agent, ["kimi-code", "kimi-code-acp"]),
  plan(context) {
    const { nativePath, target, proxy, endpoint, protocol } = context;
    const baseUrl = proxyUrl(proxy, endpoint.proxyPathSegment);
    const providerType = {
      "anthropic-messages": "anthropic",
      "openai-responses": "openai_responses",
      gemini: "google-genai",
      "openai-chat": "openai",
    }[protocol];
    const home = join(nativePath, "kimi-code");
    return {
      protocol,
      env: {
        KIMI_CODE_HOME: home,
        KIMI_DISABLE_TELEMETRY: "true",
      },
      // Kimi's env-model path overrides config and only supports three provider
      // types. Use config for all protocols so Responses/Google stay native.
      unsetEnv: ["KIMI_MODEL_NAME", "KIMI_MODEL_PROVIDER_TYPE", "KIMI_MODEL_BASE_URL", "KIMI_MODEL_API_KEY"],
      files: [{
        path: join(home, "config.toml"),
        content: [
          'default_model = "oma"',
          "[providers.oma]",
          `type = ${JSON.stringify(providerType)}`,
          `base_url = ${JSON.stringify(baseUrl)}`,
          `api_key_env = ${JSON.stringify(proxy.proxyTokenEnvVar)}`,
          "[models.oma]",
          'provider = "oma"',
          `model = ${JSON.stringify(target.wireModel)}`,
          // Preserve Kimi's env-model default when moving to its required
          // config field; this is not a claim about the model card's limit.
          "max_context_size = 262144",
          "",
        ].join("\n"),
      }],
    };
  },
};
