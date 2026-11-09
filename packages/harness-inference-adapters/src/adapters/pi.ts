import type { InferenceConfigAdapter } from "@open-managed-agents/acp-runtime/inference-config";
import { join } from "node:path";

import { matchesAgentIdentity } from "../match.js";
import { proxyUrl } from "../helpers.js";

/**
 * @openma/pi-acp 0.1.8 uses Pi 1.1 ModelRuntime, reading models.json and
 * settings.json under PI_CODING_AGENT_DIR (or its --agent-dir override).
 * - models.json `apiKey` interpolates `$VAR` / `${VAR}`; any other string is
 *   a literal key, so the gateway would get it as the bearer.
 * - settings.json `defaultProvider` / `defaultModel` pick the model of a new
 *   session (a resumed one keeps its own); an id pi does not know silently
 *   falls back to the provider's default model, so `wireModel` must be the
 *   upstream id. `quietStartup` stops pi-acp sending its banner as agent text.
 */
export const piInferenceAdapter: InferenceConfigAdapter = {
  id: "pi",
  supportedProtocols: ["openai-chat"],
  matches: (agent) => matchesAgentIdentity(agent, ["pi-acp", "openma-pi-acp"]),
  plan(context) {
    const { nativePath, target, proxy, endpoint } = context;
    const agentDir = join(nativePath, "home", ".pi", "agent");
    const baseUrl = proxyUrl(proxy, endpoint.proxyPathSegment);
    // deepseek is a pi built-in provider: its catalog (and per-model compat)
    // stays, only the endpoint and key change. Others get one custom model.
    const providerId = target.providerId === "deepseek"
      ? "deepseek"
      : "oma-hosted";
    const models = {
      providers: {
        [providerId]: {
          baseUrl,
          apiKey: `$${proxy.proxyTokenEnvVar}`,
          api: "openai-completions",
          ...(providerId === "deepseek"
            ? {}
            : {
              compat: {
                supportsDeveloperRole: false,
                thinkingFormat: "openai",
              },
              models: [{ id: target.wireModel }],
            }),
        },
      },
    };
    const settings = {
      defaultProvider: providerId,
      defaultModel: target.wireModel,
      quietStartup: true,
    };
    return {
      protocol: "openai-chat",
      env: {},
      unsetEnv: [],
      files: [
        { path: join(agentDir, "models.json"), content: `${JSON.stringify(models, null, 2)}\n` },
        { path: join(agentDir, "settings.json"), content: `${JSON.stringify(settings, null, 2)}\n` },
      ],
    };
  },
};
