import {
  createVerifierOutcomeEvaluator,
  type SessionOutcomeRubricSourcePort,
  type SessionOutcomeUsage,
} from "@open-managed-agents/session-outcomes";
import type {
  EvaluateManagedNodeOutcome,
  ManagedNodeOutcomeEvaluationPort,
  ManagedNodeOutcomeEvaluationResult,
} from "./node-managed-session-runner.js";

export interface NodeManagedJudgeUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface NodeManagedJudgeInput<Model> {
  model: Model;
  system: string;
  prompt: string;
  abortSignal: AbortSignal;
}

export interface NodeManagedOutcomeEvaluatorDependencies<Model> {
  buildModel(input: {
    workspaceId: string;
    session: EvaluateManagedNodeOutcome["session"];
    environment: EvaluateManagedNodeOutcome["environment"];
  }): Promise<Model>;
  judge(input: NodeManagedJudgeInput<Model>): Promise<{
    text: string;
    usage: NodeManagedJudgeUsage;
  }>;
  /** Workspace Files for `{ type: "file" }` rubrics. Absent: such rubrics fail. */
  rubricFiles?(workspaceId: string): SessionOutcomeRubricSourcePort;
}

const noRubricFiles: SessionOutcomeRubricSourcePort = {
  read: async () => ({ type: "unavailable", reason: "file rubrics are not configured" }),
};

/**
 * Node adapter for the per-iteration outcome evaluation Port. The judge
 * prompt, tolerant verdict parsing, retries, rubric resolution and usage
 * propagation are @open-managed-agents/session-outcomes' default LLM-judge
 * evaluator (the same one Cloudflare uses); Node only supplies the model and
 * the workspace file store.
 */
export class NodeManagedOutcomeEvaluator<Model>
  implements ManagedNodeOutcomeEvaluationPort
{
  constructor(
    private readonly dependencies: NodeManagedOutcomeEvaluatorDependencies<Model>,
  ) {}

  async evaluate(
    input: EvaluateManagedNodeOutcome,
  ): Promise<ManagedNodeOutcomeEvaluationResult> {
    const model = await this.dependencies.buildModel({
      workspaceId: input.workspaceId,
      session: input.session,
      environment: input.environment,
    });
    const evaluator = createVerifierOutcomeEvaluator<EvaluateManagedNodeOutcome["historyEvents"]>({
      judge: () => async (prompt, signal) => {
        const judged = await this.dependencies.judge({
          model,
          system: prompt.system,
          prompt: prompt.user,
          abortSignal: signal ?? input.abortSignal,
        });
        return {
          text: judged.text,
          usage: {
            input_tokens: judged.usage.inputTokens,
            output_tokens: judged.usage.outputTokens,
          },
        };
      },
      files: this.dependencies.rubricFiles?.(input.workspaceId) ?? noRubricFiles,
      verifierContext: () => {
        throw new Error("rule-based outcome verifiers are not available on Node");
      },
      history: (events) => applicationTranscriptEvents(events ?? []),
    });
    const prepared = await evaluator.prepare({
      outcome: {
        outcomeId: input.outcome.outcomeId,
        description: input.outcome.description,
        rubric: input.outcome.rubric,
        maxIterations: input.outcome.maxIterations,
      },
      abortSignal: input.abortSignal,
    });
    if (prepared.type === "failed") {
      return { result: "failed", explanation: prepared.explanation, usage: toUsage(undefined) };
    }
    const evaluation = await prepared.evaluator.evaluate({
      iteration: input.iteration,
      abortSignal: input.abortSignal,
      snapshot: input.historyEvents,
    });
    return {
      result: evaluation.result,
      explanation: evaluation.explanation,
      usage: toUsage(evaluation.usage),
    };
  }
}

function toUsage(usage: SessionOutcomeUsage | undefined): ManagedNodeOutcomeEvaluationResult["usage"] {
  return {
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

/** The judge reads agent.message text; application events carry it as content. */
function applicationTranscriptEvents(events: EvaluateManagedNodeOutcome["historyEvents"]): unknown[] {
  return events.map((event) => ({ ...event, processed_at: event.processedAt }));
}
