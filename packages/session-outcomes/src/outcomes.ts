export type SessionOutcomeRubric =
  | string
  | { type: "text"; content: string }
  | { type: "file"; fileId: string };

/** The active outcome. `rubricContent` caches a resolved rubric across turns. */
export interface SessionOutcome {
  outcomeId: string;
  description: string;
  rubric?: SessionOutcomeRubric;
  rubricContent?: string;
  /** OMA-superset rule-based check (eval-core RewardSpec wire shape). */
  verifier?: { type: string; [key: string]: unknown };
  maxIterations?: number | null;
}

export type SessionOutcomeResult =
  | "satisfied"
  | "needs_revision"
  | "max_iterations_reached"
  | "failed"
  | "interrupted";

/** AMA `span.outcome_evaluation_end.usage` (wire spelling). */
export interface SessionOutcomeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface SessionOutcomeVerdict {
  outcomeId: string;
  result: SessionOutcomeResult;
  iteration: number;
  explanation: string;
  usage?: SessionOutcomeUsage;
  /** Set when the platform event sink stamped the end span. */
  processedAt?: string;
}

/** Returned by the platform when the start span fired. */
export interface SessionOutcomeStarted {
  startEventId: string;
  /** Platform causal link carried on the end span (Cloudflare: last agent.message). */
  parentEventId?: string;
}

export interface SessionOutcomeIterationEvaluation {
  result: "satisfied" | "needs_revision" | "failed";
  explanation: string;
  usage?: SessionOutcomeUsage;
}

export interface SessionOutcomeIterationEvaluator<Snapshot = unknown> {
  /** Throws on judge/verifier error; an AbortError when interrupted. */
  evaluate(input: {
    iteration: number;
    abortSignal: AbortSignal;
    snapshot: Snapshot | undefined;
  }): Promise<SessionOutcomeIterationEvaluation>;
}

export type SessionOutcomePreparation<Snapshot = unknown> =
  | {
      type: "ready";
      evaluator: SessionOutcomeIterationEvaluator<Snapshot>;
      /** The outcome to persist when preparation resolved state (rubric cache). */
      outcome: SessionOutcome;
    }
  | { type: "failed"; explanation: string };

export interface SessionOutcomeEvaluatorPort<Snapshot = unknown> {
  prepare(input: {
    outcome: SessionOutcome;
    abortSignal: AbortSignal;
  }): Promise<SessionOutcomePreparation<Snapshot>>;
}

export interface SessionOutcomeEventsPort {
  evaluationStarted(input: { outcomeId: string; iteration: number }): SessionOutcomeStarted | Promise<SessionOutcomeStarted>;
  evaluationOngoing(input: { outcomeId: string; iteration: number }): void | Promise<void>;
  /** Returns the end span's processed_at when the platform stamped it. */
  evaluationEnded(input: {
    verdict: SessionOutcomeVerdict;
    started: SessionOutcomeStarted | null;
  }): string | undefined | void | Promise<string | undefined | void>;
}

export interface SessionOutcomeProgress {
  /** null clears the active outcome (terminal); undefined leaves it. */
  outcome?: SessionOutcome | null;
  iteration?: number;
  /** Appended to the Session's outcome evaluation aggregate. */
  verdict?: SessionOutcomeVerdict;
}

export interface SessionOutcomeProgressPort {
  persist(progress: SessionOutcomeProgress): void | Promise<void>;
}

export interface SessionOutcomeRevisionPort {
  /** Record the feedback user turn and run the harness again. */
  revise(input: { iteration: number; feedback: string }): Promise<void>;
}

export interface SessionOutcomeDependencies<Snapshot = unknown> {
  evaluator: SessionOutcomeEvaluatorPort<Snapshot>;
  events: SessionOutcomeEventsPort;
  progress: SessionOutcomeProgressPort;
  revision: SessionOutcomeRevisionPort;
  /** Optional history capture taken before each start span. */
  snapshot?(): Snapshot;
}

export interface SessionOutcomeReport {
  iterations: SessionOutcomeVerdict[];
  /** null when an abort before an iteration ended the loop silently. */
  terminal: SessionOutcomeVerdict | null;
}

export interface SessionOutcomesApplication {
  evaluate(input: {
    outcome: SessionOutcome;
    initialIteration?: number;
    abortSignal: AbortSignal;
  }): Promise<SessionOutcomeReport>;
}

const TERMINAL = new Set<SessionOutcomeResult>([
  "satisfied",
  "max_iterations_reached",
  "failed",
  "interrupted",
]);

/** AMA: default 3, max 20. Out-of-contract input falls back to the default. */
export function clampOutcomeMaxIterations(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 3;
  return Math.min(20, Math.floor(value));
}

export function outcomeFeedbackText(iteration: number, explanation: string): string {
  return [
    `<outcome_feedback iteration="${iteration}">`,
    explanation || "(no explanation)",
    "",
    "Address the feedback and try again.",
    "</outcome_feedback>",
  ].join("\n");
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "unknown error";
  return String(error);
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export function createSessionOutcomes<Snapshot = unknown>(
  dependencies: SessionOutcomeDependencies<Snapshot>,
): SessionOutcomesApplication {
  async function finish(
    outcome: SessionOutcome,
    verdict: SessionOutcomeVerdict,
    started: SessionOutcomeStarted | null,
  ): Promise<SessionOutcomeVerdict> {
    const processedAt = await dependencies.events.evaluationEnded({ verdict, started });
    const recorded = typeof processedAt === "string" ? { ...verdict, processedAt } : verdict;
    await dependencies.progress.persist(TERMINAL.has(recorded.result)
      ? { outcome: null, verdict: recorded }
      : { outcome, iteration: recorded.iteration, verdict: recorded });
    return recorded;
  }

  return {
    async evaluate({ outcome: requested, initialIteration, abortSignal }) {
      const maxIterations = clampOutcomeMaxIterations(requested.maxIterations);
      let iteration = Math.max(0, initialIteration ?? 0);
      const iterations: SessionOutcomeVerdict[] = [];

      const prepared = await dependencies.evaluator.prepare({ outcome: requested, abortSignal });
      if (prepared.type === "failed") {
        const verdict = await finish(requested, {
          outcomeId: requested.outcomeId,
          result: "failed",
          iteration,
          explanation: prepared.explanation,
        }, null);
        return { iterations: [verdict], terminal: verdict };
      }
      const outcome = prepared.outcome;
      if (outcome !== requested) await dependencies.progress.persist({ outcome });

      while (iteration < maxIterations) {
        // AMA: "interrupted" is only reported once a start span fired. An abort
        // between iterations ends the loop silently and drops the outcome.
        if (abortSignal.aborted) {
          await dependencies.progress.persist({ outcome: null });
          return { iterations, terminal: null };
        }
        const snapshot = dependencies.snapshot?.();
        const started = await dependencies.events.evaluationStarted({ outcomeId: outcome.outcomeId, iteration });
        await dependencies.events.evaluationOngoing({ outcomeId: outcome.outcomeId, iteration });

        let result: SessionOutcomeResult;
        let explanation: string;
        let usage: SessionOutcomeUsage | undefined;
        try {
          const evaluation = await prepared.evaluator.evaluate({ iteration, abortSignal, snapshot });
          explanation = evaluation.explanation;
          usage = evaluation.usage;
          result = evaluation.result === "needs_revision" && iteration >= maxIterations - 1
            ? "max_iterations_reached"
            : evaluation.result;
        } catch (error) {
          const interrupted = isAbort(error, abortSignal);
          result = interrupted ? "interrupted" : "failed";
          explanation = interrupted
            ? "outcome evaluation interrupted by user"
            : `verifier error: ${describe(error)}`;
        }

        const verdict = await finish(outcome, {
          outcomeId: outcome.outcomeId,
          result,
          iteration,
          explanation,
          ...(usage !== undefined && { usage }),
        }, started);
        iterations.push(verdict);
        if (TERMINAL.has(verdict.result)) return { iterations, terminal: verdict };

        iteration += 1;
        await dependencies.progress.persist({ outcome, iteration });
        try {
          await dependencies.revision.revise({
            iteration,
            feedback: outcomeFeedbackText(iteration - 1, explanation),
          });
        } catch (error) {
          if (abortSignal.aborted) throw error;
          const failed = await finish(outcome, {
            outcomeId: outcome.outcomeId,
            result: "failed",
            iteration,
            explanation: `harness crashed during revision: ${describe(error)}`,
          }, null);
          iterations.push(failed);
          throw error;
        }
      }

      // Unreachable for a positive maxIterations; kept as a defensive terminal.
      const verdict = await finish(outcome, {
        outcomeId: outcome.outcomeId,
        result: "max_iterations_reached",
        iteration: iteration - 1,
        explanation: "supervisor loop exited without a terminal verdict",
      }, null);
      iterations.push(verdict);
      return { iterations, terminal: verdict };
    },
  };
}
