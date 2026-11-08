// Cloudflare adapter for the Session outcome grader loop.
//
// The loop, the verdict mapping and the default verifier / LLM-judge
// evaluator live in @open-managed-agents/session-outcomes (#545 §0.7). This
// module only maps SessionDO state (snake_case `state.outcome`,
// `state.outcome_iteration`, `state.outcome_evaluations[]`) and wire events
// onto that package's Ports:
//   - events: start, ongoing and end spans are appended to history and
//     broadcast (SessionOutcomeEventsPort); the end span carries the
//     `feedback` alias and the last agent.message as `parent_event_id`.
//   - progress: SessionState deltas through `persistState`.
//   - revision: append the feedback user.message and run the harness again.
//   - rubric files: R2 `FILES_BUCKET` at the tenant file key.

import type {
  AgentMessageEvent,
  RubricSpec,
  SessionEvent,
  SpanOutcomeEvaluationEndEvent,
  SpanOutcomeEvaluationOngoingEvent,
  SpanOutcomeEvaluationStartEvent,
  StoredEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import { fileR2Key, generateEventId } from "@open-managed-agents/shared";
import type { JudgeFn, VerifierContext } from "@open-managed-agents/shared";
import {
  createSessionOutcomes,
  createVerifierOutcomeEvaluator,
  type SessionOutcome,
  type SessionOutcomeRubricSourcePort,
  type SessionOutcomeUsage,
  type SessionOutcomeVerdict,
} from "@open-managed-agents/session-outcomes";

/** AMA `span.outcome_evaluation_end.usage` shape. */
export type OutcomeUsage = SessionOutcomeUsage;

/** Persisted aggregate row. Mirrors what session-do writes to
 *  `state.outcome_evaluations[]`. */
export interface OutcomeEvaluationRecord {
  outcome_id: string;
  result:
    | "satisfied"
    | "needs_revision"
    | "max_iterations_reached"
    | "failed"
    | "interrupted";
  iteration: number;
  explanation?: string;
  /** @deprecated alias of explanation. Both written for back-compat. */
  feedback?: string;
  usage?: OutcomeUsage;
  processed_at?: string;
}

/** Active outcome state, as stored on `SessionState.outcome`. */
export interface ActiveOutcomeState {
  outcome_id: string;
  description: string;
  rubric?: string | RubricSpec;
  /** Cached resolved rubric markdown (set lazily on first iteration). */
  rubric_content?: string;
  /** OMA-superset rule-based check. Wire shape mirrors RewardSpec. */
  verifier?: { type: string; [key: string]: unknown };
  max_iterations?: number;
}

export interface OutcomeSupervisorDeps {
  outcome: ActiveOutcomeState;
  /** Iteration to start at. 0-indexed (AMA-spec). */
  initialIteration?: number;
  /** Tenant id — used by the rubric file resolver. */
  tenantId: string;
  filesBucket: R2Bucket | null | undefined;
  /** Append-and-broadcast for events that go to history + WS. */
  appendAndBroadcast: (event: SessionEvent) => void;
  /** Read all events for the current iteration's trajectory build. */
  getEvents: () => StoredEvent[] | SessionEvent[];
  /** Build a verifier from the OMA-superset RewardSpec branch. */
  makeVerifierContext: () => VerifierContext;
  /** Build the LLM-judge callback (closure over generateText). */
  makeJudgeFn: () => JudgeFn;
  /** Optional model identifier used for the verifier id (logs / metadata). */
  judgeModelId?: string;
  /** Run another harness turn after a needs_revision verdict. */
  runHarnessTurn: (msg: UserMessageEvent) => Promise<void>;
  /** Persist a delta back to SessionState. Caller decides what to merge. */
  persistState: (delta: {
    outcome?: ActiveOutcomeState | null;
    outcome_iteration?: number;
    outcome_evaluations?: OutcomeEvaluationRecord[];
  }) => void;
  /** Read the current persisted outcome_evaluations[]. */
  readEvaluations: () => OutcomeEvaluationRecord[];
  /** Mid-eval interrupt detection. */
  abortSignal: AbortSignal;
}

export interface OutcomeSupervisorReport {
  iterations: OutcomeEvaluationRecord[];
  /** null when an interrupt before an iteration's start span ended the loop. */
  terminal: OutcomeEvaluationRecord | null;
}

function toSessionOutcome(outcome: ActiveOutcomeState): SessionOutcome {
  const rubric = outcome.rubric;
  return {
    outcomeId: outcome.outcome_id,
    description: outcome.description,
    ...(rubric === undefined ? {} : {
      rubric: typeof rubric === "string" || rubric.type === "text"
        ? rubric
        : { type: "file" as const, fileId: rubric.file_id },
    }),
    ...(outcome.rubric_content === undefined ? {} : { rubricContent: outcome.rubric_content }),
    ...(outcome.verifier === undefined ? {} : { verifier: outcome.verifier }),
    ...(outcome.max_iterations === undefined ? {} : { maxIterations: outcome.max_iterations }),
  };
}

function toRecord(verdict: SessionOutcomeVerdict): OutcomeEvaluationRecord {
  return {
    outcome_id: verdict.outcomeId,
    result: verdict.result,
    iteration: verdict.iteration,
    explanation: verdict.explanation,
    feedback: verdict.explanation,
    usage: verdict.usage,
    processed_at: verdict.processedAt,
  };
}

function findLastAgentMessageId(events: StoredEvent[] | SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as SessionEvent;
    if (event.type === "agent.message") return (event as AgentMessageEvent).id;
  }
  return undefined;
}

function r2RubricFiles(tenantId: string, bucket: R2Bucket | null | undefined): SessionOutcomeRubricSourcePort {
  return {
    async read({ fileId }) {
      if (!bucket) return { type: "unavailable", reason: "FILES_BUCKET binding not configured" };
      const object = await bucket.get(fileR2Key(tenantId, fileId));
      return object ? { type: "found", text: await object.text() } : { type: "not_found" };
    },
  };
}

/**
 * Run the grader loop until a terminal verdict. A failed verifier, judge or
 * rubric lands in the verdict as `failed`; a crashed revision turn records a
 * `failed` verdict and rethrows.
 */
export async function runOutcomeSupervisor(
  deps: OutcomeSupervisorDeps,
): Promise<OutcomeSupervisorReport> {
  const original = deps.outcome;
  // The persisted state keeps its own spelling; only the rubric cache moves.
  const toState = (outcome: SessionOutcome): ActiveOutcomeState =>
    outcome.rubricContent === undefined || outcome.rubricContent === original.rubric_content
      ? original
      : { ...original, rubric_content: outcome.rubricContent };

  const outcomes = createSessionOutcomes<StoredEvent[] | SessionEvent[]>({
    evaluator: createVerifierOutcomeEvaluator({
      judge: deps.makeJudgeFn,
      judgeModelId: deps.judgeModelId,
      files: r2RubricFiles(deps.tenantId, deps.filesBucket),
      verifierContext: deps.makeVerifierContext,
      history: () => deps.getEvents(),
    }),
    events: {
      evaluationStarted({ outcomeId, iteration }) {
        const parentEventId = findLastAgentMessageId(deps.getEvents());
        const start: SpanOutcomeEvaluationStartEvent = {
          type: "span.outcome_evaluation_start",
          id: generateEventId(),
          outcome_id: outcomeId,
          iteration,
          ...(parentEventId ? { parent_event_id: parentEventId } : {}),
        };
        deps.appendAndBroadcast(start);
        return { startEventId: start.id!, ...(parentEventId ? { parentEventId } : {}) };
      },
      evaluationOngoing({ outcomeId, iteration }) {
        const ongoing: SpanOutcomeEvaluationOngoingEvent = {
          type: "span.outcome_evaluation_ongoing",
          outcome_id: outcomeId,
          iteration,
        };
        deps.appendAndBroadcast(ongoing);
      },
      evaluationEnded({ verdict, started }) {
        const end: SpanOutcomeEvaluationEndEvent = {
          type: "span.outcome_evaluation_end",
          outcome_id: verdict.outcomeId,
          ...(started ? { outcome_evaluation_start_id: started.startEventId } : {}),
          result: verdict.result,
          iteration: verdict.iteration,
          explanation: verdict.explanation,
          // Back-compat alias: console + RL collector still read .feedback.
          feedback: verdict.explanation,
          ...(verdict.usage ? { usage: verdict.usage } : {}),
          ...(started?.parentEventId ? { parent_event_id: started.parentEventId } : {}),
        };
        deps.appendAndBroadcast(end);
        return end.processed_at;
      },
    },
    progress: {
      persist({ outcome, iteration, verdict }) {
        deps.persistState({
          ...(outcome === undefined ? {} : { outcome: outcome === null ? null : toState(outcome) }),
          ...(iteration === undefined ? {} : { outcome_iteration: iteration }),
          ...(verdict === undefined ? {} : {
            outcome_evaluations: [...deps.readEvaluations(), toRecord(verdict)],
          }),
        });
      },
    },
    revision: {
      async revise({ feedback }) {
        const message: UserMessageEvent = {
          type: "user.message",
          content: [{ type: "text", text: feedback }],
        };
        deps.appendAndBroadcast(message);
        await deps.runHarnessTurn(message);
      },
    },
  });

  const report = await outcomes.evaluate({
    outcome: toSessionOutcome(original),
    initialIteration: deps.initialIteration,
    abortSignal: deps.abortSignal,
  });
  return {
    iterations: report.iterations.map(toRecord),
    terminal: report.terminal === null ? null : toRecord(report.terminal),
  };
}
