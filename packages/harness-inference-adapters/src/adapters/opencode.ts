import type { InferenceConfigAdapter } from "@open-managed-agents/acp-runtime/inference-config";

import { matchesAgentIdentity } from "../match.js";
import { proxyUrl } from "../helpers.js";

export const opencodeInferenceAdapter: InferenceConfigAdapter = {
  id: "opencode",
  supportedProtocols: ["anthropic-messages", "openai-responses", "gemini"],
  matches: (agent) => matchesAgentIdentity(agent, ["opencode"]),
  plan(context) {
    const { target, proxy, endpoint, protocol } = context;
    const baseURL = proxyUrl(proxy, endpoint.proxyPathSegment);
    const modelId = `oma/${target.wireModel}`;
    // OpenCode v1's provider.npm contract. Do not mix in v2 package fields.
    const npm = {
      "anthropic-messages": "@ai-sdk/anthropic",
      "openai-responses": "@ai-sdk/openai",
      gemini: "@ai-sdk/google",
    }[protocol];
    const config = {
      share: "disabled",
      model: modelId,
      small_model: modelId,
      provider: {
        oma: {
          npm,
          models: { [target.wireModel]: { name: target.wireModel } },
          options: {
            baseURL,
            apiKey: `{env:${proxy.proxyTokenEnvVar}}`,
          },
        },
      },
    };
    return {
      protocol,
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      unsetEnv: [],
      files: [],
    };
  },
};
