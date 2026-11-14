import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import type { ScriptedLanguageModelStep } from "../../../test/fakes/scripted-language-model";

/** Small Pi-native model fixture for Cloudflare integration tests. */
export function createScriptedPiRuntime(
  steps: ScriptedLanguageModelStep[],
  options: { provider?: string; modelId?: string } = {},
): {
  runtime: {
    models: Models;
    model: Model<Api>;
    thinkingLevel: "off";
    speed: "standard";
  };
  get callCount(): number;
  assertExhausted(): void;
} {
  const provider = options.provider ?? "openma-scripted-pi";
  const modelId = options.modelId ?? "scripted-pi-model";
  let calls = 0;
  const faux = fauxProvider({
    provider,
    models: [{ id: modelId, contextWindow: 128_000, maxTokens: 4_096 }],
    tokensPerSecond: 100_000,
  });
  faux.setResponses(steps.map((step) => () => {
    calls += 1;
    if (step.type === "request-error") {
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: step.error.message });
    }
    const content: any[] = [];
    let text = "";
    for (const chunk of step.chunks) {
      if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
        text += chunk.delta;
      } else if (chunk.type === "tool-call") {
        const input = typeof chunk.input === "string" ? chunk.input : "{}";
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(input) as Record<string, unknown>; } catch { /* malformed input is handled downstream */ }
        content.push(fauxToolCall(String(chunk.toolName), args as never, { id: String(chunk.toolCallId) }));
      }
    }
    if (text.length > 0) content.unshift({ type: "text", text });
    const hasToolCall = content.some((part) => part.type === "toolCall");
    return fauxAssistantMessage(content, { stopReason: hasToolCall ? "toolUse" : "stop" });
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = models.getModel(provider, modelId);
  if (!model) throw new Error(`scripted Pi model ${provider}/${modelId} was not registered`);
  return {
    runtime: { models, model, thinkingLevel: "off", speed: "standard" },
    get callCount() { return calls; },
    assertExhausted() {
      if (calls !== steps.length) throw new Error(`Scripted Pi model has ${steps.length - calls} unconsumed step(s)`);
    },
  };
}
