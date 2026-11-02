import type { InferenceConfigAdapter } from "@open-managed-agents/acp-runtime/inference-config";
import { join } from "node:path";

import { matchesAgentIdentity } from "../match.js";
import { proxyUrl } from "../helpers.js";

export const claudeInferenceAdapter: InferenceConfigAdapter = {
  id: "claude-code",
  supportedProtocols: ["anthropic-messages"],
  matches: (agent) => matchesAgentIdentity(agent, [
    "claude-acp",
    "claude-agent-acp",
    "claude-code-acp",
  ]),
  plan(context) {
    const { nativePath, target, proxy, endpoint } = context;
    const baseUrl = proxyUrl(proxy, endpoint.proxyPathSegment);
    const model = target.wireModel;
    return {
      protocol: "anthropic-messages",
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: proxy.proxyToken,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        CLAUDE_CODE_SUBAGENT_MODEL: model,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      unsetEnv: ["ANTHROPIC_API_KEY"],
      files: [{
        path: join(nativePath, "settings.json"),
        content: `${JSON.stringify({ model }, null, 2)}\n`,
      }],
    };
  },
};
