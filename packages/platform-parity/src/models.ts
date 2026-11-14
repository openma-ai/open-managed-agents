import type { ScriptedLanguageModelStep } from "../../../test/fakes/scripted-language-model";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";

/** A scripted stream step, or a step that blocks until the call is aborted. */
export type ParityModelStep =
  | ScriptedLanguageModelStep
  | { type: "await-abort"; timeoutMs?: number };

interface AgentScript {
  pi: { models: Models; model: Model<Api> };
  totalSteps: number;
  calls: number;
  aborted: number;
  timedOut: number;
}

/**
 * Per-run model registry. The runner's "platform-parity" harness asks it for
 * the model of the agent it is about to run (by canonical agent name), so a
 * parent, its subagent and a later turn each consume their own script. Both
 * runners execute the harness in the same isolate / process as the test, so
 * module state is the injection point (same pattern as
 * test/integration/mcp-managed-turn.test.ts).
 */
class ParityModelRegistry {
  private scripts = new Map<string, AgentScript>();
  private run = "";
  private stray = 0;

  /** Start a run: only agents named `<name><runSuffix>` may draw models. */
  reset(runSuffix = ""): void {
    this.scripts.clear();
    this.run = runSuffix;
    this.stray = 0;
  }

  install(agentName: string, steps: ParityModelStep[]): void {
    const script = {
      pi: undefined as unknown as { models: Models; model: Model<Api> },
      totalSteps: steps.length,
      calls: 0,
      aborted: 0,
      timedOut: 0,
    } satisfies AgentScript;
    const faux = fauxProvider({
      provider: "openma-parity",
      models: [{ id: "parity-model", contextWindow: 128_000, maxTokens: 4_096 }],
      tokensPerSecond: 100_000,
    });
    faux.setResponses(steps.map((step) => parityStepToPiResponse(step, script)));
    const models = createModels();
    models.setProvider(faux.provider);
    script.pi = { models, model: models.getModel("openma-parity", "parity-model")! };
    this.scripts.set(agentName, script);
  }

  /** Pi-native model runtime for the Pi host harness parity runner. */
  piRuntimeFor(agentName: string | undefined): {
    models: Models;
    model: Model<Api>;
    thinkingLevel: "off";
    speed: "standard";
  } {
    const full = agentName ?? "";
    const name = canonicalAgentName(full);
    if (this.run && !full.endsWith(this.run)) {
      this.stray += 1;
      throw new Error(`platform-parity: model requested by agent ${JSON.stringify(full)} outside the active run`);
    }
    const script = this.scripts.get(name);
    if (script === undefined) {
      throw new Error(`platform-parity: no scripted Pi model installed for agent ${JSON.stringify(name)}`);
    }
    return { ...script.pi, thinkingLevel: "off", speed: "standard" };
  }

  /** Public-observable summary: how many model calls each agent made. */
  summary(): Record<string, { calls: number; unconsumed_steps: number; aborted: number; timed_out: number }> {
    const out: Record<string, { calls: number; unconsumed_steps: number; aborted: number; timed_out: number }> = {};
    for (const [name, script] of [...this.scripts].sort(([a], [b]) => a.localeCompare(b))) {
      out[name] = {
        calls: script.calls,
        unconsumed_steps: Math.max(0, script.totalSteps - script.calls),
        aborted: script.aborted,
        timed_out: script.timedOut,
      };
    }
    return out;
  }

  /** Model requests from agents outside the active run (stray turns). */
  strayRequests(): number {
    return this.stray;
  }
}

function parityStepToPiResponse(step: ParityModelStep, script: AgentScript) {
  if (step.type === "await-abort") {
    return (_context: unknown, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      script.calls += 1;
      const timeoutMs = step.timeoutMs ?? 8_000;
      const timer = setTimeout(() => {
        script.timedOut += 1;
        reject(new Error("platform-parity: await-abort step timed out without an abort"));
      }, timeoutMs);
      const signal = options?.signal;
      const onAbort = () => {
        clearTimeout(timer);
        script.aborted += 1;
        reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  if (step.type === "request-error") {
    return () => {
      script.calls += 1;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: step.error.message });
    };
  }
  const content: any[] = [];
  for (const chunk of step.chunks) {
    if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
      content.push({ type: "text", text: chunk.delta });
    } else if (chunk.type === "tool-call") {
      const input = typeof chunk.input === "string" ? chunk.input : "{}";
      let arguments_: Record<string, unknown> = {};
      try { arguments_ = JSON.parse(input) as Record<string, unknown>; } catch { /* provider will surface malformed input */ }
      content.push(fauxToolCall(String(chunk.toolName), arguments_ as never, { id: String(chunk.toolCallId) }));
    }
  }
  const finish = step.chunks.find((chunk) => chunk.type === "finish") as { finishReason?: { unified?: string } } | undefined;
  const stopReason = finish?.finishReason?.unified === "tool-calls" || content.some((part) => part.type === "toolCall")
    ? "toolUse" as const
    : "stop" as const;
  return () => {
    script.calls += 1;
    return fauxAssistantMessage(content, { stopReason });
  };
}

export const parityModels = new ParityModelRegistry();

/** Agent names are run-suffixed (`name~run`) so stores never collide. */
export const RUN_SUFFIX_SEPARATOR = "~";

export function canonicalAgentName(name: string): string {
  const index = name.indexOf(RUN_SUFFIX_SEPARATOR);
  return index < 0 ? name : name.slice(0, index);
}
