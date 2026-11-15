import { describe, expect, it } from "vitest";
import {
  buildOutcomeTrajectory,
  createVerifierOutcomeEvaluator,
  resolveOutcomeRubric,
  type SessionOutcome,
  type SessionOutcomeRubricFile,
  type SessionOutcomeRubricSourcePort,
  type VerifierOutcomeEvaluatorDependencies,
} from "../src/index.js";

const noFiles: SessionOutcomeRubricSourcePort = {
  read: async () => { throw new Error("unexpected file read"); },
};

function files(result: SessionOutcomeRubricFile, reads: string[] = []): SessionOutcomeRubricSourcePort {
  return { read: async ({ fileId }) => { reads.push(fileId); return result; } };
}

function deps(overrides: Partial<VerifierOutcomeEvaluatorDependencies<string[]>> = {}): VerifierOutcomeEvaluatorDependencies<string[]> {
  return {
    judge: () => async () => ({ text: JSON.stringify({ result: "satisfied", explanation: "fine" }) }),
    judgeModelId: "judge-model",
    files: noFiles,
    verifierContext: () => ({ sessionId: "sess", runExec: async () => ({ exit_code: 0, output: "" }) }),
    history: (snapshot) => (snapshot ?? []).map((text, i) => ({
      type: "agent.message", id: `m${i}`, content: [{ type: "text", text }],
    })),
    ...overrides,
  };
}

const outcome: SessionOutcome = { outcomeId: "outc_1", description: "Say hello", rubric: { type: "text", content: "Mentions hello" } };

describe("resolveOutcomeRubric", () => {
  it("accepts inline text and legacy strings", async () => {
    await expect(resolveOutcomeRubric({ type: "text", content: "x" }, noFiles)).resolves.toEqual({ ok: true, content: "x" });
    await expect(resolveOutcomeRubric("legacy", noFiles)).resolves.toEqual({ ok: true, content: "legacy" });
  });

  it("rejects missing and empty rubrics with the stable error strings", async () => {
    await expect(resolveOutcomeRubric(undefined, noFiles)).resolves.toEqual({ ok: false, error: "no rubric provided" });
    await expect(resolveOutcomeRubric("  ", noFiles)).resolves.toEqual({ ok: false, error: "rubric is empty" });
    await expect(resolveOutcomeRubric({ type: "text", content: " " }, noFiles)).resolves.toEqual({ ok: false, error: "rubric.content is empty" });
    await expect(resolveOutcomeRubric({ type: "file", fileId: "" }, noFiles)).resolves.toEqual({ ok: false, error: "rubric.file_id is empty" });
  });

  it("reads file rubrics through the port", async () => {
    const reads: string[] = [];
    await expect(resolveOutcomeRubric({ type: "file", fileId: "file_1" }, files({ type: "found", text: "from file" }, reads)))
      .resolves.toEqual({ ok: true, content: "from file" });
    expect(reads).toEqual(["file_1"]);
    await expect(resolveOutcomeRubric({ type: "file", fileId: "file_1" }, files({ type: "not_found" })))
      .resolves.toEqual({ ok: false, error: "rubric file fetch failed: not found (file_id=file_1)" });
    await expect(resolveOutcomeRubric({ type: "file", fileId: "file_1" }, files({ type: "found", text: "\n" })))
      .resolves.toEqual({ ok: false, error: "rubric file fetch failed: empty body (file_id=file_1)" });
    await expect(resolveOutcomeRubric({ type: "file", fileId: "file_1" }, files({ type: "unavailable", reason: "FILES_BUCKET binding not configured" })))
      .resolves.toEqual({ ok: false, error: "rubric file fetch failed: FILES_BUCKET binding not configured" });
    await expect(resolveOutcomeRubric({ type: "file", fileId: "file_1" }, { read: async () => { throw new Error("io"); } }))
      .resolves.toEqual({ ok: false, error: "rubric file fetch failed: io" });
  });
});

describe("buildOutcomeTrajectory", () => {
  it("wraps wire events in the StoredEvent envelope and passes stored events through", () => {
    const stored = { seq: 7, type: "agent.message", data: "{}", ts: "t" };
    const trajectory = buildOutcomeTrajectory([{ type: "user.message", processed_at: "p" }, stored]);
    expect(trajectory.events).toEqual([
      { seq: 0, type: "user.message", data: JSON.stringify({ type: "user.message", processed_at: "p" }), ts: "p" },
      stored,
    ]);
    expect(trajectory.summary.num_events).toBe(2);
  });
});

describe("createVerifierOutcomeEvaluator", () => {
  it("judges the agent transcript against the rubric and propagates usage", async () => {
    const prompts: Array<{ system: string; user: string }> = [];
    const evaluator = createVerifierOutcomeEvaluator(deps({
      judge: () => async (prompt) => {
        prompts.push(prompt);
        return {
          text: "Verdict: " + JSON.stringify({ result: "needs_revision", explanation: "say it louder" }),
          usage: { input_tokens: 10, output_tokens: 2 },
        };
      },
    }));
    const prepared = await evaluator.prepare({ outcome, abortSignal: new AbortController().signal });
    if (prepared.type !== "ready") throw new Error("expected ready");
    expect(prepared.outcome).toEqual({ ...outcome, rubricContent: "Mentions hello" });

    const result = await prepared.evaluator.evaluate({ iteration: 0, abortSignal: new AbortController().signal, snapshot: ["hello there"] });
    expect(result).toEqual({ result: "needs_revision", explanation: "say it louder", usage: { input_tokens: 10, output_tokens: 2 } });
    expect(prompts[0]!.user).toContain("Say hello");
    expect(prompts[0]!.user).toContain("Mentions hello");
    expect(prompts[0]!.user).toContain("hello there");
  });

  it("reuses a cached rubric without reading files", async () => {
    const evaluator = createVerifierOutcomeEvaluator(deps());
    const cached = { ...outcome, rubric: { type: "file" as const, fileId: "file_1" }, rubricContent: "cached rubric" };
    const prepared = await evaluator.prepare({ outcome: cached, abortSignal: new AbortController().signal });
    expect(prepared).toMatchObject({ type: "ready", outcome: cached });
  });

  it("fails preparation when the rubric cannot be resolved", async () => {
    const evaluator = createVerifierOutcomeEvaluator(deps({ files: files({ type: "not_found" }) }));
    await expect(evaluator.prepare({
      outcome: { ...outcome, rubric: { type: "file", fileId: "file_1" } },
      abortSignal: new AbortController().signal,
    })).resolves.toEqual({ type: "failed", explanation: "rubric file fetch failed: not found (file_id=file_1)" });
  });

  it("runs rule-based verifiers through the sandbox context", async () => {
    const commands: string[] = [];
    const evaluator = createVerifierOutcomeEvaluator(deps({
      verifierContext: () => ({ sessionId: "sess", runExec: async (cmd) => { commands.push(cmd); return { exit_code: 1, output: "nope" }; } }),
    }));
    const prepared = await evaluator.prepare({
      outcome: { outcomeId: "o", description: "d", verifier: { type: "script", verify_script: "test -f x" } },
      abortSignal: new AbortController().signal,
    });
    if (prepared.type !== "ready") throw new Error("expected ready");
    const result = await prepared.evaluator.evaluate({ iteration: 0, abortSignal: new AbortController().signal, snapshot: [] });
    expect(commands).toEqual(["test -f x"]);
    expect(result.result).toBe("needs_revision");
  });

  it("fails preparation for an unknown verifier", async () => {
    const evaluator = createVerifierOutcomeEvaluator(deps());
    const prepared = await evaluator.prepare({
      outcome: { outcomeId: "o", description: "d", verifier: { type: "verifiable", scorer: "definitelyDoesNotExist" } },
      abortSignal: new AbortController().signal,
    });
    expect(prepared.type).toBe("failed");
    expect(prepared.type === "failed" && prepared.explanation).toMatch(/^verifier construction failed: /);
  });
});
