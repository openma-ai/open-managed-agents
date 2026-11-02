import type { InferenceConfigAdapter } from "@open-managed-agents/acp-runtime/inference-config";

import { matchesAgentIdentity } from "../match.js";
import { proxyUrl } from "../helpers.js";

export const dshInferenceAdapter: InferenceConfigAdapter = {
  id: "dsh",
  supportedProtocols: ["anthropic-messages"],
  matches: (agent) => matchesAgentIdentity(agent, [
    "dsh-acp",
    "deepseek-harness-acp",
  ]),
  plan(context) {
    const { target, proxy, endpoint } = context;
    const baseUrl = proxyUrl(proxy, endpoint.proxyPathSegment);
    return {
      protocol: "anthropic-messages",
      env: {
        DEEPSEEK_BASE_URL: baseUrl,
        DEEPSEEK_API_KEY: context.proxy.proxyToken,
        DSH_PROVIDER: "deepseek-official",
        DSH_MODEL: target.wireModel,
      },
      unsetEnv: [],
      files: [],
    };
  },
};
