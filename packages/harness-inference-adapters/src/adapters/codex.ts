import type { InferenceConfigAdapter } from "@open-managed-agents/acp-runtime/inference-config";
import { join } from "node:path";

import { matchesAgentIdentity } from "../match.js";
import { proxyUrl } from "../helpers.js";

export const codexInferenceAdapter: InferenceConfigAdapter = {
  id: "codex",
  supportedProtocols: ["openai-responses"],
  matches: (agent) => matchesAgentIdentity(agent, [
    "codex-acp",
    "codex-cli",
    "codex-acp-bridge",
  ]),
  plan(context) {
    const { nativePath, proxy, endpoint } = context;
    const baseUrl = proxyUrl(proxy, endpoint.proxyPathSegment);
    const config = [
      "model_provider = \"oma\"",
      "",
      "[model_providers.oma]",
      `base_url = "${baseUrl}"`,
      `env_key = "${proxy.proxyTokenEnvVar}"`,
      "wire_api = \"responses\"",
      "",
    ].join("\n");
    return {
      protocol: "openai-responses",
      env: {},
      unsetEnv: [],
      files: [{
        path: join(nativePath, "config.toml"),
        content: `${config}`,
      }],
    };
  },
};
