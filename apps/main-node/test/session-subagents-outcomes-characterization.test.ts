// Characterization tests (#545 §0.7 regression rule) for the Node side of the
// two Session runtime domains converged into packages/session-subagents and
// packages/session-outcomes. Written on the base commit (94d603e7) and kept
// unchanged on the converged code: they pin only behaviour both
// implementations share. Intentional changes are asserted in the converged
// package tests and listed in the convergence report.
import { describe, expect, it } from "vitest";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { MemorySessionThreadStore } from "../../../packages/session-thread-store-memory/src/index";
import {
  DefaultNodeManagedSessionRunner,
  type DefaultNodeManagedSessionRunnerDependencies,
} from "../../../packages/control-plane-node/src/lib/node-managed-session-runner";
import { resolveManagedSubagentSession } from "../../../packages/control-plane-node/src/lib/node-managed-subagents";
import type { ManagedNodeHarnessRuntime } from "../../../packages/control-plane-node/src/lib/node-managed-harness-runtime";

const baseSession: Session = {
  id: "session_charz", agent: { id: "parent", description: null, mcpServers: [],
    model: { id: "local-model" }, multiagent: null, name: "Parent", skills: [],
    system: "Parent instructions", tools: [], version: 1 }, archivedAt: null, budget: null,
  createdAt: "2026-09-11T00:00:00Z", environmentId: "env", metadata: {},
  outcomeEvaluations: [], resources: [], stats: {}, status: "running", title: null,
  updatedAt: "2026-09-11T00:00:00Z", usage: {}, vaultIds: [],
};
const environment: Environment = { id: "env", config: { type: "self_hosted" },
  archivedAt: null, createdAt: baseSession.createdAt, updatedAt: baseSession.updatedAt,
  name: "Shared", description: null, metadata: {} };

function nativeSession(): Session {
  const session = structuredClone(baseSession);
  session.agent.multiagent = {
    type: "multiagent_20261001", advisor: { type: "disabled" }, workflows: { type: "disabled" },
    subagents: { type: "enabled", inlineAgents: { type: "enabled" }, predefinedAgents: [
      { ...structuredClone(baseSession.agent), type: "agent", id: "worker", name: "Worker",
        system: "Worker instructions", version: 3 } as never,
    ] },
  } as never;
  return session;
}

type Ctx = { session: Session; runtime: ManagedNodeHarnessRuntime; sandbox: SandboxExecutor };
type Delegate = (agentId: string, message: string) => Promise<string>;

function subagentFixture(run: (ctx: Ctx, delegate: Delegate) => Promise<void>) {
  const session = nativeSession();
  const frames: Record<string, unknown>[] = [];
  let delegate: Delegate | undefined;
  let id = 0;
  const deps: DefaultNodeManagedSessionRunnerDependencies = {
    buildSandbox: async () => ({ exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }) as unknown as SandboxExecutor,
    buildModel: async () => ({}) as HarnessContext["model"],
    buildTools: async (input) => {
      if (input.delegateToAgent !== undefined) delegate = input.delegateToAgent;
      return {};
    },
    buildHarnessContext: async (input) => input as unknown as HarnessContext,
    buildHarness: () => ({ run: async (context) => run(context as unknown as Ctx, delegate!) }),
    confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool"); } },
    outcomes: { evaluate: async () => { throw new Error("unexpected outcome"); } },
    clock: { now: () => new Date("2026-09-11T00:00:00Z") },
    ids: { nextEventId: () => `event_${++id}` },
    subagentThreads: new MemorySessionThreadStore(),
    subagentPolicy: () => ({ enabled: true, maxConcurrentSubagents: 2 }),
    resolveSubagentSession: async ({ session: active, request }) => resolveManagedSubagentSession(active, request),
  };
  const runner = new DefaultNodeManagedSessionRunner(deps);
  return {
    frames,
    async run() {
      await runner.start({ workspaceId: "workspace", sessionId: session.id, session, environment, initialEvents: [] });
      const message = { id: `input_${++id}`, type: "user.message" as const,
        content: [{ type: "text" as const, text: "Parent task" }], processedAt: session.createdAt };
      await runner.accept({ workspaceId: "workspace", sessionId: session.id, session, environment,
        initialEvents: [], historyEvents: [message], events: [message],
        output: async (frame) => { frames.push(frame as Record<string, unknown>); } });
    },
  };
}

describe("characterization: Node subagent delegation (call_agent_* path)", () => {
  it("returns the pinned child's final text and records the child lane", async () => {
    const results: string[] = [];
    let childSystem: string | null = null;
    const f = subagentFixture(async ({ session, runtime }, delegate) => {
      if (session.agent.name === "Parent") {
        results.push(await delegate("worker", "Find the answer"));
      } else {
        childSystem = session.agent.system;
        expect(session.agent.multiagent).toBeNull();
        runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "child answer" }] });
      }
    });
    await f.run();
    expect(results).toEqual(["child answer"]);
    expect(childSystem).toBe("Worker instructions");
    const created = f.frames.filter((frame) => frame.type === "session.thread_created");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ agent_name: "Worker", parent_thread_id: "sthr_primary" });
    const childThread = created[0]!.session_thread_id;
    expect(f.frames).toContainEqual(expect.objectContaining({
      type: "agent.message", session_thread_id: childThread,
      content: [{ type: "text", text: "child answer" }],
    }));
    expect(f.frames.filter((frame) => frame.type === "session.status_idle")).toHaveLength(1);
  });

  it("returns a placeholder when the child produced no text", async () => {
    const results: string[] = [];
    const f = subagentFixture(async ({ session }, delegate) => {
      if (session.agent.name === "Parent") results.push(await delegate("worker", "Quiet"));
    });
    await f.run();
    expect(results).toEqual(["(sub-agent produced no text output)"]);
  });

  it("rejects an agent outside the pinned roster without creating a thread", async () => {
    const errors: string[] = [];
    const f = subagentFixture(async ({ session }, delegate) => {
      if (session.agent.name === "Parent") {
        await delegate("unlisted", "nope").catch((error: Error) => { errors.push(error.message); });
      }
    });
    await f.run();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/roster/i);
    expect(f.frames.some((frame) => frame.type === "session.thread_created")).toBe(false);
  });

  it("rejects the delegate call when the child fails, scoping the error to the child lane", async () => {
    const errors: string[] = [];
    const f = subagentFixture(async ({ session }, delegate) => {
      if (session.agent.name === "Parent") {
        await delegate("worker", "Fail").catch((error: Error) => { errors.push(error.message); });
      } else {
        throw new Error("child provider failed");
      }
    });
    await f.run();
    expect(errors).toHaveLength(1);
    const childThread = f.frames.find((frame) => frame.type === "session.thread_created")!.session_thread_id;
    expect(f.frames.filter((frame) => frame.type === "session.error")).toEqual([
      expect.objectContaining({ session_thread_id: childThread,
        error: expect.objectContaining({ message: "child provider failed" }) }),
    ]);
  });
});

type Evaluate = DefaultNodeManagedSessionRunnerDependencies["outcomes"]["evaluate"];

function outcomeFixture(evaluate: Evaluate, run: (ctx: Ctx) => Promise<void> = async () => {}) {
  const session = structuredClone(baseSession);
  const frames: Record<string, unknown>[] = [];
  let runs = 0;
  let id = 0;
  const runner = new DefaultNodeManagedSessionRunner({
    outcomes: { evaluate },
    confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool"); } },
    buildSandbox: async () => ({}) as SandboxExecutor,
    buildModel: async () => ({}) as HarnessContext["model"],
    buildTools: async () => ({}),
    buildHarness: () => ({ run: async (context) => { runs += 1; await run(context as unknown as Ctx); } }),
    buildHarnessContext: async (input) => input as unknown as HarnessContext,
    clock: { now: () => new Date("2026-09-11T00:00:00Z") },
    ids: { nextEventId: () => `event_${++id}` },
    harnessRetry: { attempts: 1, delayMs: () => 0 },
  });
  return {
    frames, runner, session,
    get runs() { return runs; },
    async accept(maxIterations: number) {
      await runner.start({ workspaceId: "workspace", sessionId: session.id, session, environment, initialEvents: [] });
      const outcome = { id: `define_${++id}`, type: "user.define_outcome" as const,
        description: "Ship it", rubric: { type: "text" as const, content: "Done" },
        maxIterations, outcomeId: "outc_charz", processedAt: session.createdAt };
      await runner.accept({ workspaceId: "workspace", sessionId: session.id, session, environment,
        events: [outcome], initialEvents: [], historyEvents: [outcome],
        output: async (frame) => { frames.push(frame as Record<string, unknown>); } });
    },
  };
}

const usage = { cacheCreationInputTokens: 0, cacheReadInputTokens: 0, inputTokens: 1, outputTokens: 1 };
const ends = (frames: Record<string, unknown>[]) =>
  frames.filter((frame) => frame.type === "span.outcome_evaluation_end");

describe("characterization: Node outcome evaluation loop", () => {
  it("ends with max_iterations_reached without another revision when max_iterations is 1", async () => {
    const iterations: number[] = [];
    const f = outcomeFixture(async (input) => {
      iterations.push(input.iteration);
      return { result: "needs_revision", explanation: "not yet", usage };
    });
    await f.accept(1);
    expect(f.runs).toBe(1);
    expect(iterations).toEqual([0]);
    expect(ends(f.frames).map((frame) => frame.result)).toEqual(["max_iterations_reached"]);
  });

  it("caps max_iterations at 20", async () => {
    const iterations: number[] = [];
    const f = outcomeFixture(async (input) => {
      iterations.push(input.iteration);
      return { result: "needs_revision", explanation: "again", usage };
    });
    await f.accept(25);
    expect(iterations).toHaveLength(20);
    expect(ends(f.frames).at(-1)).toMatchObject({ result: "max_iterations_reached", iteration: 19 });
  });

  it("records a failed verdict when the evaluator throws and still ends the turn normally", async () => {
    const f = outcomeFixture(async () => { throw new Error("judge down"); });
    await f.accept(3);
    expect(f.runs).toBe(1);
    const end = ends(f.frames);
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ result: "failed", iteration: 0, outcome_id: "outc_charz" });
    expect(String(end[0]!.explanation)).toContain("judge down");
    expect(end[0]!.outcome_evaluation_start_id).toBe(
      f.frames.find((frame) => frame.type === "span.outcome_evaluation_start")!.id,
    );
    expect(f.frames.some((frame) => frame.type === "session.error")).toBe(false);
    expect(f.frames.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
  });

  it("records interrupted when the evaluation is cancelled", async () => {
    let started!: () => void;
    const evaluating = new Promise<void>((resolve) => { started = resolve; });
    const f = outcomeFixture((input) => new Promise((_resolve, reject) => {
      started();
      input.abortSignal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));
    const accepted = f.accept(3).catch(() => undefined);
    await evaluating;
    f.runner.cancel({ workspaceId: "workspace", sessionId: f.session.id });
    await accepted;
    const end = ends(f.frames);
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ result: "interrupted", iteration: 0 });
  });

  it("fails the turn when the revision harness run crashes", async () => {
    let call = 0;
    const f = outcomeFixture(
      async () => ({ result: "needs_revision", explanation: "fix it", usage }),
      async () => { call += 1; if (call === 2) throw new Error("revision crashed"); },
    );
    await expect(f.accept(3)).rejects.toThrow(/revision crashed/);
    expect(f.frames).toContainEqual(expect.objectContaining({
      type: "session.error",
      error: expect.objectContaining({ message: "revision crashed", retry_status: "exhausted" }),
    }));
    expect(ends(f.frames)[0]).toMatchObject({ result: "needs_revision", iteration: 0 });
  });
});
