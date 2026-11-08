import { describe, expect, it } from "vitest";
import { DefaultNodeManagedSessionRunner } from "../../../packages/control-plane-node/src/lib/node-managed-session-runner.js";
import { createSessionClockRegistry } from "@open-managed-agents/shared";
import { beginModelEgress, completeModelEgress, type SessionBudgetGate } from "../../../packages/managed-agents-domain/src/sessions/index.js";

type Frame = Record<string, unknown>;
const T = "2026-08-26T03:00:00.000Z";
const PRICING = { version: 1, currency: "USD", input_per_mtok: "1", output_per_mtok: "1" } as const;
const environment = { id: "env_1", name: "env", config: { type: "cloud" } };

function session(budget?: unknown) {
  return { id: "sess_1", agent: { id: "a", name: "Agent", version: 1 }, usage: {}, ...(budget ? { budget } : {}) };
}

async function turn(run: (context: { runtime: any; budget?: SessionBudgetGate | null }) => Promise<void>, budget?: unknown) {
  const frames: Frame[] = [];
  let n = 0;
  let runs = 0;
  const runner = new DefaultNodeManagedSessionRunner({
    sessionClocks: createSessionClockRegistry(),
    outcomes: { evaluate: async () => { throw new Error("unexpected"); } },
    confirmedTools: { execute: async () => { throw new Error("unexpected"); } },
    buildSandbox: async () => ({}),
    buildModel: async () => ({}),
    buildTools: async () => ({}),
    resolveModelPricing: async () => PRICING,
    buildHarness: () => ({ run: async (context: never) => { runs += 1; await run(context); } }),
    buildHarnessContext: async (context: unknown) => context,
    clock: { now: () => new Date(T) },
    ids: { nextEventId: () => `sevt_${++n}` },
    runtimeGenerations: { next: () => "runtime_1" },
    harnessRetry: { attempts: 3, delayMs: () => 0 },
  } as never);
  const value = session(budget);
  const scope = { workspaceId: "workspace", sessionId: value.id };
  await runner.start({ ...scope, session: value, environment, initialEvents: [] } as never);
  const message = { id: "sevt_input", type: "user.message", content: [{ type: "text", text: "go" }], processedAt: T };
  const result = await runner.accept({
    ...scope, session: value, environment, initialEvents: [], events: [message], historyEvents: [message],
    output: async (frame: Frame) => { frames.push(frame); },
  } as never).then(() => undefined, (error: unknown) => error);
  const summary = frames.map((frame) => frame.type === "session.error"
    ? `error:${(frame.error as { retry_status: string }).retry_status}`
    : frame.type === "session.status_idle"
      ? `idle:${(frame.stop_reason as { type: string }).type}`
      : String(frame.type));
  return { result, runs, summary };
}

describe("characterization: one Node turn", () => {
  it("a parked tool call outranks budget_reached (requires_action, as on Cloudflare)", async () => {
    const { summary } = await turn(async ({ runtime, budget }) => {
      runtime.broadcast({ type: "agent.custom_tool_use", id: "ctu_1", name: "ask", input: {} });
      runtime.pendingConfirmations.push("ctu_1");
      completeModelEgress(budget, { input_tokens: 1_000_000 });
      beginModelEgress(budget);
    }, { amountMinor: "100", currency: "USD" });
    expect(summary.at(-1)).toBe("idle:requires_action");
  });

  it("does not retry an authentication failure", async () => {
    const { runs, summary } = await turn(async () => { throw new Error("401 unauthorized"); });
    expect(runs).toBe(1);
    expect(summary.at(-1)).toBe("idle:retries_exhausted");
  });

  it("does not retry after an agent event", async () => {
    const { runs, summary } = await turn(async ({ runtime }) => {
      runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "partial" }] });
      throw new Error("boom");
    });
    expect(runs).toBe(1);
    expect(summary).toEqual(["session.status_running", "agent.message", "error:exhausted", "idle:retries_exhausted"]);
  });
});
