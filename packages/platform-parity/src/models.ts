import {
  createScriptedLanguageModel,
  type ScriptedLanguageModelStep,
} from "../../../test/fakes/scripted-language-model";

/** A scripted stream step, or a step that blocks until the call is aborted. */
export type ParityModelStep =
  | ScriptedLanguageModelStep
  | { type: "await-abort"; timeoutMs?: number };

type ScriptedModel = ReturnType<typeof createScriptedLanguageModel>["model"];
/** The language-model surface the harness uses (structural subset of the scripted model). */
export type ParityLanguageModel = Pick<ScriptedModel, "specificationVersion" | "provider" | "modelId" | "supportedUrls" | "doGenerate" | "doStream">;

interface AgentScript {
  scripted: ReturnType<typeof createScriptedLanguageModel>;
  order: Array<"scripted" | "await-abort">;
  awaits: Array<{ timeoutMs: number }>;
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
    const streamSteps = steps.filter((step): step is ScriptedLanguageModelStep => step.type !== "await-abort");
    this.scripts.set(agentName, {
      scripted: createScriptedLanguageModel(streamSteps, {
        provider: "openma-parity",
        modelId: "parity-model",
      }),
      order: steps.map((step) => (step.type === "await-abort" ? "await-abort" : "scripted")),
      awaits: steps.flatMap((step) => (step.type === "await-abort" ? [{ timeoutMs: step.timeoutMs ?? 8_000 }] : [])),
      calls: 0,
      aborted: 0,
      timedOut: 0,
    });
  }

  /** Model for the agent whose (possibly run-suffixed) name is given. */
  modelFor(agentName: string | undefined): ParityLanguageModel {
    const full = agentName ?? "";
    const name = canonicalAgentName(full);
    if (this.run && !full.endsWith(this.run)) {
      // A turn left over from an earlier scenario (e.g. a retry loop) must not
      // consume this run's script.
      this.stray += 1;
      throw new Error(`platform-parity: model requested by agent ${JSON.stringify(full)} outside the active run`);
    }
    const script = this.scripts.get(name);
    if (script === undefined) {
      throw new Error(`platform-parity: no scripted model installed for agent ${JSON.stringify(name)}`);
    }
    const inner = script.scripted.model;
    const model: ParityLanguageModel = {
      specificationVersion: inner.specificationVersion,
      provider: inner.provider,
      modelId: inner.modelId,
      supportedUrls: inner.supportedUrls,
      doGenerate: (options) => inner.doGenerate(options),
      doStream: async (options) => {
        const kind = script.order[script.calls];
        script.calls += 1;
        if (kind !== "await-abort") return inner.doStream(options);
        const gate = script.awaits.shift() ?? { timeoutMs: 8_000 };
        await new Promise<void>((resolve, reject) => {
          const signal = options.abortSignal;
          const timer = setTimeout(() => {
            script.timedOut += 1;
            reject(new Error("platform-parity: await-abort step timed out without an abort"));
          }, gate.timeoutMs);
          const onAbort = () => {
            clearTimeout(timer);
            script.aborted += 1;
            reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
          void resolve;
        });
        throw new Error("unreachable");
      },
    };
    return model;
  }

  /** Public-observable summary: how many model calls each agent made. */
  summary(): Record<string, { calls: number; unconsumed_steps: number; aborted: number; timed_out: number }> {
    const out: Record<string, { calls: number; unconsumed_steps: number; aborted: number; timed_out: number }> = {};
    for (const [name, script] of [...this.scripts].sort(([a], [b]) => a.localeCompare(b))) {
      out[name] = {
        calls: script.calls,
        unconsumed_steps: Math.max(0, script.order.length - script.calls),
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

export const parityModels = new ParityModelRegistry();

/** Agent names are run-suffixed (`name~run`) so stores never collide. */
export const RUN_SUFFIX_SEPARATOR = "~";

export function canonicalAgentName(name: string): string {
  const index = name.indexOf(RUN_SUFFIX_SEPARATOR);
  return index < 0 ? name : name.slice(0, index);
}
