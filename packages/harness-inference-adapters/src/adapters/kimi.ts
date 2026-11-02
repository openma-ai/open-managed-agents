import type { InferenceConfigAdapter } from "@open-managed-agents/acp-runtime/inference-config";
import { join } from "node:path";

import { matchesAgentIdentity } from "../match.js";
import { proxyUrl } from "../helpers.js";

export const kimiCodeInferenceAdapter: InferenceConfigAdapter = {
  id: "kimi-code",
  supportedProtocols: ["openai-chat"],
  matches: (agent) => matchesAgentIdentity(agent, ["kimi-code", "kimi-code-acp"]),
  plan(context) {
    const { nativePath, target, proxy, endpoint } = context;
    const baseUrl = proxyUrl(proxy, endpoint.proxyPathSegment);
    return {
      protocol: "openai-chat",
      env: {
        KIMI_MODEL_NAME: target.wireModel,
        KIMI_MODEL_PROVIDER_TYPE: "openai",
        KIMI_MODEL_BASE_URL: baseUrl,
        KIMI_MODEL_API_KEY: proxy.proxyToken,
        KIMI_CODE_HOME: join(nativePath, "kimi-code"),
        KIMI_DISABLE_TELEMETRY: "true",
      },
      unsetEnv: [],
      files: [],
    };
  },
};
