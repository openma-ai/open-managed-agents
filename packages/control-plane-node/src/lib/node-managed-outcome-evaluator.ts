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
}

function rubricText(outcome: EvaluateManagedNodeOutcome["outcome"]): string {
  return outcome.rubric.type === "text"
    ? outcome.rubric.content
    : `[file rubric: ${outcome.rubric.fileId}]`;
}

function judgePrompt(input: EvaluateManagedNodeOutcome): string {
  return [
    `Outcome: ${input.outcome.description}`,
    `Rubric: ${rubricText(input.outcome)}`,
    `Iteration: ${input.iteration}`,
    "Session history (application event JSON):",
    JSON.stringify(input.historyEvents),
    "Return only JSON with result equal to satisfied, needs_revision, or failed, and a string explanation.",
  ].join("\n\n");
}

function decodeJudgeResult(text: string): Pick<
  ManagedNodeOutcomeEvaluationResult,
  "result" | "explanation"
> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Outcome judge returned invalid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Outcome judge returned invalid JSON");
  }
  const record = value as Record<string, unknown>;
  if (
    record.result !== "satisfied" &&
    record.result !== "needs_revision" &&
    record.result !== "failed"
  ) {
    throw new Error("Outcome judge returned an invalid result");
  }
  if (typeof record.explanation !== "string") {
    throw new Error("Outcome judge returned an invalid explanation");
  }
  return { result: record.result, explanation: record.explanation };
}

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
    const judged = await this.dependencies.judge({
      model,
      system:
        "You are a strict outcome evaluator. Judge only against the supplied outcome, rubric, and event history.",
      prompt: judgePrompt(input),
      abortSignal: input.abortSignal,
    });
    return {
      ...decodeJudgeResult(judged.text),
      usage: {
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        inputTokens: judged.usage.inputTokens,
        outputTokens: judged.usage.outputTokens,
      },
    };
  }
}
