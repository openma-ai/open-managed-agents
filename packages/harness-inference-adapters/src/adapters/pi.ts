import type { InferenceConfigAdapter } from "@open-managed-agents/acp-runtime/inference-config";
import { join } from "node:path";

import { matchesAgentIdentity } from "../match.js";
import { proxyUrl } from "../helpers.js";

export const piInferenceAdapter: InferenceConfigAdapter = {
  id: "pi",
  supportedProtocols: ["openai-chat"],
  matches: (agent) => matchesAgentIdentity(agent, ["pi-acp"]),
  plan(context) {
    const { nativePath, target, proxy, endpoint } = context;
    const modelsPath = join(
      nativePath,
      "home",
      ".pi",
      "agent",
      "models.json",
    );
    const baseUrl = proxyUrl(proxy, endpoint.proxyPathSegment);
    const providerId = target.providerId === "deepseek"
      ? "deepseek"
      : "oma-hosted";
    const models = {
      providers: {
        [providerId]: {
          baseUrl,
          apiKey: `{env:${proxy.proxyTokenEnvVar}}`,
          api: "openai-completions",
          ...(providerId === "deepseek"
            ? {}
            : {
              compat: {
                supportsDeveloperRole: false,
                thinkingFormat: "openai",
              },
            }),
        },
      },
    };
    return {
      protocol: "openai-chat",
      env: {
        PI_ACP_MODEL: `${providerId}/${target.wireModel}`,
      },
      unsetEnv: [],
      files: [{
        path: modelsPath,
        content: `${JSON.stringify(models, null, 2)}\n`,
      }],
    };
  },
};
