import { InferenceConfigAdapterRegistry } from "@open-managed-agents/acp-runtime/inference-config";

import { claudeInferenceAdapter } from "./adapters/claude.js";
import { codexInferenceAdapter } from "./adapters/codex.js";
import { dshInferenceAdapter } from "./adapters/dsh.js";
import { geminiInferenceAdapter } from "./adapters/gemini.js";
import { kimiCodeInferenceAdapter } from "./adapters/kimi.js";
import { opencodeInferenceAdapter } from "./adapters/opencode.js";
import { piInferenceAdapter } from "./adapters/pi.js";

export function createDefaultHarnessInferenceAdapterRegistry(): InferenceConfigAdapterRegistry {
  const registry = new InferenceConfigAdapterRegistry();
  registry
    .register(piInferenceAdapter)
    .register(dshInferenceAdapter)
    .register(claudeInferenceAdapter)
    .register(codexInferenceAdapter)
    .register(geminiInferenceAdapter)
    .register(opencodeInferenceAdapter)
    .register(kimiCodeInferenceAdapter);
  return registry;
}
