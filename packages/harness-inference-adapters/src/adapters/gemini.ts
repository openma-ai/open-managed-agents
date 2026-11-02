import type { InferenceConfigAdapter } from "@open-managed-agents/acp-runtime/inference-config";
import { join } from "node:path";

import { matchesAgentIdentity } from "../match.js";
import { proxyUrl } from "../helpers.js";

export const geminiInferenceAdapter: InferenceConfigAdapter = {
  id: "gemini",
  supportedProtocols: ["gemini"],
  matches: (agent) => matchesAgentIdentity(agent, ["gemini", "gemini-cli"]),
  plan(context) {
    const { nativePath, proxy, endpoint } = context;
    const baseUrl = proxyUrl(proxy, endpoint.proxyPathSegment);
    return {
      protocol: "gemini",
      env: {
        GOOGLE_GEMINI_BASE_URL: baseUrl,
        GEMINI_API_KEY: "",
        GEMINI_CLI_CUSTOM_HEADERS: `Authorization: Bearer {env:${proxy.proxyTokenEnvVar}}`,
      },
      unsetEnv: ["GOOGLE_API_KEY"],
      files: [{
        path: join(nativePath, ".gemini", "settings.json"),
        content: `${JSON.stringify({ selectedType: "gateway" }, null, 2)}\n`,
      }],
    };
  },
};
