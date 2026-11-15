import { describe, expect, it } from "vitest";
import {
  clampOutcomeMaxIterations,
  createSessionOutcomes,
  outcomeFeedbackText,
  type SessionOutcome,
  type SessionOutcomeDependencies,
  type SessionOutcomeIterationEvaluation,
  type SessionOutcomeProgress,
  type SessionOutcomeStarted,
  type SessionOutcomeVerdict,
} from "../src/index.js";

type Step = SessionOutcomeIterationEvaluation | Error | ((signal: AbortSignal) => Promise<SessionOutcomeIterationEvaluation>);

function fixture(input: {
  steps: Step[];
  prepareFailure?: string;
  preparedOutcome?: (outcome: SessionOutcome) => SessionOutcome;
  revise?: (iteration: number) => Promise<void> | void;
}) {
  const log: string[] = [];
  const progress: SessionOutcomeProgress[] = [];
  const ended: Array<{ verdict: SessionOutcomeVerdict; started: SessionOutcomeStarted | null }> = [];
  const feedback: Array<{ iteration: number; feedback: string }> = [];
  const snapshots: unknown[] = [];
  let evaluations = 0;
  let starts = 0;
  const deps: SessionOutcomeDependencies<number> = {
    evaluator: {
      async prepare({ outcome }) {
        log.push("prepare");
        if (input.prepareFailure !== undefined) return { type: "failed", explanation: input.prepareFailure };
        return {
          type: "ready",
          outcome: input.preparedOutcome?.(outcome) ?? outcome,
          evaluator: {
            async evaluate({ iteration, abortSignal, snapshot }) {
              log.push(`evaluate:${iteration}`);
              snapshots.push(snapshot);
              const step = input.steps[evaluations++];
              if (step === undefined) throw new Error("no scripted step");
              if (step instanceof Error) throw step;
              if (typeof step === "function") return step(abortSignal);
              return step;
            },
          },
        };
      },
    },
    events: {
      evaluationStarted({ iteration }) {
        log.push(`start:${iteration}`);
        starts += 1;
        return { startEventId: `start_${starts}` };
      },
      evaluationOngoing({ iteration }) { log.push(`ongoing:${iteration}`); },
      evaluationEnded({ verdict, started }) {
        log.push(`end:${verdict.iteration}:${verdict.result}`);
        ended.push({ verdict, started });
        return `2026-01-01T00:00:0${ended.length}Z`;
      },
    },
    progress: { persist(p) { progress.push(structuredClone(p)); } },
    revision: {
      async revise({ iteration, feedback: text }) {
        log.push(`revise:${iteration}`);
        feedback.push({ iteration, feedback: text });
        await input.revise?.(iteration);
      },
    },
    snapshot: () => { log.push("snapshot"); return log.length; },
  };
  return { deps, log, progress, ended, feedback, snapshots, outcomes: createSessionOutcomes(deps) };
}

const outcome: SessionOutcome = {
  outcomeId: "outc_1",
  description: "Ship it",
  rubric: { type: "text", content: "Done" },
  maxIterations: 3,
};
const pass = (explanation = "ok"): SessionOutcomeIterationEvaluation => ({ result: "satisfied", explanation });
const revise = (explanation = "again"): SessionOutcomeIterationEvaluation => ({ result: "needs_revision", explanation });
const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

describe("createSessionOutcomes", () => {
  it("emits start, ongoing and end spans and clears the outcome on satisfied", async () => {
    const f = fixture({ steps: [{ ...pass("good"), usage: { input_tokens: 3, output_tokens: 1 } }] });
    const report = await f.outcomes.evaluate({ outcome, abortSignal: new AbortController().signal });

    expect(f.log).toEqual(["prepare", "snapshot", "start:0", "ongoing:0", "evaluate:0", "end:0:satisfied"]);
    expect(report.terminal).toEqual({
      outcomeId: "outc_1", result: "satisfied", iteration: 0, explanation: "good",
      usage: { input_tokens: 3, output_tokens: 1 }, processedAt: "2026-01-01T00:00:01Z",
    });
    expect(report.iterations).toEqual([report.terminal]);
    expect(f.ended[0]!.started).toEqual({ startEventId: "start_1" });
    expect(f.progress).toEqual([{ outcome: null, verdict: report.terminal }]);
  });

  it("injects feedback and re-runs the harness on needs_revision", async () => {
    const f = fixture({ steps: [revise("missing file"), pass()] });
    const report = await f.outcomes.evaluate({ outcome, abortSignal: new AbortController().signal });

    expect(report.iterations.map((v) => [v.result, v.iteration])).toEqual([["needs_revision", 0], ["satisfied", 1]]);
    expect(f.feedback).toEqual([{ iteration: 1, feedback: outcomeFeedbackText(0, "missing file") }]);
    expect(f.feedback[0]!.feedback).toBe(
      '<outcome_feedback iteration="0">\nmissing file\n\nAddress the feedback and try again.\n</outcome_feedback>',
    );
    expect(f.progress).toEqual([
      { outcome, iteration: 0, verdict: report.iterations[0] },
      { outcome, iteration: 1 },
      { outcome: null, verdict: report.iterations[1] },
    ]);
  });

  it("reports max_iterations_reached on the last allowed iteration without another revision", async () => {
    const f = fixture({ steps: [revise(), revise()] });
    const report = await f.outcomes.evaluate({ outcome: { ...outcome, maxIterations: 2 }, abortSignal: new AbortController().signal });

    expect(report.iterations.map((v) => [v.result, v.iteration])).toEqual([["needs_revision", 0], ["max_iterations_reached", 1]]);
    expect(f.feedback).toHaveLength(1);
  });

  it("caps max iterations at 20 and defaults invalid values to 3", async () => {
    const f = fixture({ steps: Array.from({ length: 25 }, () => revise()) });
    const report = await f.outcomes.evaluate({ outcome: { ...outcome, maxIterations: 25 }, abortSignal: new AbortController().signal });
    expect(report.iterations).toHaveLength(20);
    expect(report.terminal).toMatchObject({ result: "max_iterations_reached", iteration: 19 });

    expect(clampOutcomeMaxIterations(undefined)).toBe(3);
    expect(clampOutcomeMaxIterations(null)).toBe(3);
    expect(clampOutcomeMaxIterations(0)).toBe(3);
    expect(clampOutcomeMaxIterations(Number.NaN)).toBe(3);
    expect(clampOutcomeMaxIterations(2.7)).toBe(2);
    expect(clampOutcomeMaxIterations(20)).toBe(20);
  });

  it("resumes at the persisted iteration", async () => {
    const f = fixture({ steps: [revise()] });
    const report = await f.outcomes.evaluate({ outcome, initialIteration: 2, abortSignal: new AbortController().signal });
    expect(report.terminal).toMatchObject({ result: "max_iterations_reached", iteration: 2 });
  });

  it("ends failed when the evaluator itself reports failed", async () => {
    const f = fixture({ steps: [{ result: "failed", explanation: "judge refused" }] });
    const report = await f.outcomes.evaluate({ outcome, abortSignal: new AbortController().signal });
    expect(report.terminal).toMatchObject({ result: "failed", explanation: "judge refused" });
    expect(f.feedback).toEqual([]);
  });

  it("records a failed verdict linked to the start span when the evaluator throws", async () => {
    const f = fixture({ steps: [new Error("judge down")] });
    const report = await f.outcomes.evaluate({ outcome, abortSignal: new AbortController().signal });
    expect(report.terminal).toMatchObject({ result: "failed", iteration: 0, explanation: "verifier error: judge down" });
    expect(f.ended[0]!.started).toEqual({ startEventId: "start_1" });
  });

  it("records interrupted when the evaluation is aborted after the start span", async () => {
    const controller = new AbortController();
    const f = fixture({
      steps: [(signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
        queueMicrotask(() => controller.abort());
      })],
    });
    const report = await f.outcomes.evaluate({ outcome, abortSignal: controller.signal });
    expect(report.terminal).toMatchObject({ result: "interrupted", explanation: "outcome evaluation interrupted by user" });
    expect(f.progress.at(-1)).toMatchObject({ outcome: null });
  });

  it("stops silently and drops the outcome when aborted before an iteration starts", async () => {
    const controller = new AbortController();
    const f = fixture({ steps: [revise()], revise: () => controller.abort() });
    const report = await f.outcomes.evaluate({ outcome, abortSignal: controller.signal });

    expect(report.terminal).toBeNull();
    expect(report.iterations.map((v) => v.result)).toEqual(["needs_revision"]);
    expect(f.log.filter((entry) => entry.startsWith("start:"))).toEqual(["start:0"]);
    expect(f.progress.at(-1)).toEqual({ outcome: null });
  });

  it("reports a failed preparation once, without a start span", async () => {
    const f = fixture({ steps: [], prepareFailure: "rubric file fetch failed: not found (file_id=f)" });
    const report = await f.outcomes.evaluate({ outcome, abortSignal: new AbortController().signal });
    expect(f.log).toEqual(["prepare", "end:0:failed"]);
    expect(report.terminal).toMatchObject({ result: "failed", explanation: "rubric file fetch failed: not found (file_id=f)" });
    expect(f.ended[0]!.started).toBeNull();
    expect(f.progress).toEqual([{ outcome: null, verdict: report.terminal }]);
  });

  it("persists the outcome the preparation resolved (rubric cache)", async () => {
    const f = fixture({ steps: [pass()], preparedOutcome: (o) => ({ ...o, rubricContent: "cached" }) });
    await f.outcomes.evaluate({ outcome, abortSignal: new AbortController().signal });
    expect(f.progress[0]).toEqual({ outcome: { ...outcome, rubricContent: "cached" } });
  });

  it("records a failed verdict and rethrows when the revision turn crashes", async () => {
    const f = fixture({ steps: [revise()], revise: () => { throw new Error("revision crashed"); } });
    await expect(f.outcomes.evaluate({ outcome, abortSignal: new AbortController().signal })).rejects.toThrow("revision crashed");
    expect(f.ended.map(({ verdict, started }) => [verdict.result, verdict.iteration, started])).toEqual([
      ["needs_revision", 0, { startEventId: "start_1" }],
      ["failed", 1, null],
    ]);
    expect(f.ended[1]!.verdict.explanation).toBe("harness crashed during revision: revision crashed");
    expect(f.progress.at(-1)).toMatchObject({ outcome: null });
  });

  it("rethrows an aborted revision turn without another verdict", async () => {
    const controller = new AbortController();
    const f = fixture({ steps: [revise()], revise: () => { controller.abort(); throw abortError(); } });
    await expect(f.outcomes.evaluate({ outcome, abortSignal: controller.signal })).rejects.toThrow("aborted");
    expect(f.ended.map(({ verdict }) => verdict.result)).toEqual(["needs_revision"]);
  });

  it("captures the history snapshot before each start span", async () => {
    const f = fixture({ steps: [revise(), pass()] });
    await f.outcomes.evaluate({ outcome, abortSignal: new AbortController().signal });
    expect(f.snapshots).toHaveLength(2);
    expect(f.log.indexOf("snapshot")).toBeLessThan(f.log.indexOf("start:0"));
  });
});
