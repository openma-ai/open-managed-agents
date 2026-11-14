import {
  createLlmJudgeVerifier,
  verifierForSpec,
  type JudgeFn,
  type RewardSpec,
  type Trajectory,
  type Verifier,
  type VerifierContext,
} from "@open-managed-agents/eval-core";
import type {
  SessionOutcome,
  SessionOutcomeEvaluatorPort,
  SessionOutcomeRubric,
  SessionOutcomeUsage,
} from "./outcomes.js";

type StoredEvent = Trajectory["events"][number];

export type SessionOutcomeRubricFile =
  | { type: "found"; text: string }
  | { type: "not_found" }
  | { type: "unavailable"; reason: string };

/** Reads a `{ type: "file" }` rubric's bytes from the platform's file store. */
export interface SessionOutcomeRubricSourcePort {
  read(input: { fileId: string }): Promise<SessionOutcomeRubricFile>;
}

export type OutcomeRubricResolution =
  | { ok: true; content: string }
  | { ok: false; error: string };

/** Resolve an outcome rubric to markdown (inline text, legacy string, or file). */
export async function resolveOutcomeRubric(
  rubric: SessionOutcomeRubric | undefined,
  files: SessionOutcomeRubricSourcePort,
): Promise<OutcomeRubricResolution> {
  if (rubric === undefined) return { ok: false, error: "no rubric provided" };
  if (typeof rubric === "string") {
    return rubric.trim().length > 0
      ? { ok: true, content: rubric }
      : { ok: false, error: "rubric is empty" };
  }
  if (rubric.type === "text") {
    return rubric.content && rubric.content.trim()
      ? { ok: true, content: rubric.content }
      : { ok: false, error: "rubric.content is empty" };
  }
  if (!rubric.fileId) return { ok: false, error: "rubric.file_id is empty" };
  try {
    const file = await files.read({ fileId: rubric.fileId });
    if (file.type === "unavailable") {
      return { ok: false, error: `rubric file fetch failed: ${file.reason}` };
    }
    if (file.type === "not_found") {
      return { ok: false, error: `rubric file fetch failed: not found (file_id=${rubric.fileId})` };
    }
    if (!file.text.trim()) {
      return { ok: false, error: `rubric file fetch failed: empty body (file_id=${rubric.fileId})` };
    }
    return { ok: true, content: file.text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `rubric file fetch failed: ${message.slice(0, 200)}` };
  }
}

/**
 * Minimal Trajectory for verifier consumption. Events already in the
 * StoredEvent envelope pass through; deserialized wire events are wrapped so
 * eval-core scorer helpers (which parse `data`) see their payload.
 */
export function buildOutcomeTrajectory(events: readonly unknown[]): Trajectory {
  const wrapped: StoredEvent[] = events.map((event, index) => {
    const stored = event as Partial<StoredEvent>;
    if (typeof stored.data === "string" && typeof stored.seq === "number") return stored as StoredEvent;
    const wire = event as { type?: string; processed_at?: string };
    return {
      seq: index,
      type: wire.type ?? "unknown",
      data: JSON.stringify(event),
      ts: wire.processed_at ?? new Date(0).toISOString(),
    };
  });
  return {
    schema_version: "oma.trajectory.v1",
    trajectory_id: "supervisor-inline",
    session_id: "supervisor-inline",
    agent_config: {} as Trajectory["agent_config"],
    environment_config: { workspace: "not independently verified", network: "unknown" } as unknown as Trajectory["environment_config"],
    model: { id: "supervisor-inline", provider: "" },
    started_at: new Date(0).toISOString(),
    outcome: "running",
    events: wrapped,
    summary: {
      num_events: wrapped.length,
      num_turns: 0,
      num_tool_calls: 0,
      num_tool_errors: 0,
      num_threads: 0,
      duration_ms: 0,
      token_usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

export interface VerifierOutcomeEvaluatorDependencies<Snapshot = unknown> {
  /** In-process LLM judge (closure over the platform model client). */
  judge(): JudgeFn;
  judgeModelId?: string;
  files: SessionOutcomeRubricSourcePort;
  /** Sandbox handle for rule-based (`verifier`) outcomes. */
  verifierContext(): VerifierContext;
  /** Session events in wire form, read when an iteration evaluates. */
  history(snapshot: Snapshot | undefined): readonly unknown[];
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "unknown error";
  return String(error);
}

/**
 * Default evaluator for both platforms: rule-based outcomes go through
 * eval-core `verifierForSpec`; rubric outcomes use the LLM-judge verifier
 * (tolerant JSON parsing, retries, judge token usage).
 */
export function createVerifierOutcomeEvaluator<Snapshot = unknown>(
  dependencies: VerifierOutcomeEvaluatorDependencies<Snapshot>,
): SessionOutcomeEvaluatorPort<Snapshot> {
  return {
    async prepare({ outcome, abortSignal }) {
      let verifier: Verifier;
      let resolved: SessionOutcome = outcome;
      if (outcome.verifier) {
        try {
          verifier = verifierForSpec(outcome.verifier as unknown as RewardSpec, dependencies.verifierContext());
        } catch (error) {
          return { type: "failed", explanation: `verifier construction failed: ${describe(error)}` };
        }
      } else {
        let rubric = outcome.rubricContent;
        if (!rubric) {
          const resolution = await resolveOutcomeRubric(outcome.rubric, dependencies.files);
          if (!resolution.ok) return { type: "failed", explanation: resolution.error };
          rubric = resolution.content;
          resolved = { ...outcome, rubricContent: rubric };
        }
        verifier = createLlmJudgeVerifier({
          rubric,
          description: outcome.description,
          modelId: dependencies.judgeModelId,
          judge: dependencies.judge(),
          abortSignal,
        });
      }
      return {
        type: "ready",
        outcome: resolved,
        evaluator: {
          async evaluate({ snapshot }) {
            const events = dependencies.history(snapshot);
            const score = await verifier.check(buildOutcomeTrajectory(events));
            const usage = (score.metadata as { usage?: SessionOutcomeUsage } | undefined)?.usage;
            return {
              result: score.pass ? "satisfied" : "needs_revision",
              explanation: score.reason || "",
              ...(usage !== undefined && { usage }),
            };
          },
        },
      };
    },
  };
}
