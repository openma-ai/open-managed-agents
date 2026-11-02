import type { InferenceConfigAdapter } from "@open-managed-agents/acp-runtime/inference-config";

import { matchesAgentIdentity } from "../match.js";
import { proxyUrl } from "../helpers.js";

export const opencodeInferenceAdapter: InferenceConfigAdapter = {
  id: "opencode",
  supportedProtocols: ["openai-chat"],
  matches: (agent) => matchesAgentIdentity(agent, ["opencode"]),
  plan(context) {
    const { target, proxy, endpoint } = context;
    const baseURL = proxyUrl(proxy, endpoint.proxyPathSegment);
    const modelId = `oma/${target.wireModel}`;
    const config = {
      share: "disabled",
      model: modelId,
      small_model: modelId,
      provider: {
        oma: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL,
            apiKey: `{env:${proxy.proxyTokenEnvVar}}`,
          },
        },
      },
    };
    return {
      protocol: "openai-chat",
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      unsetEnv: [],
      files: [],
    };
  },
};
