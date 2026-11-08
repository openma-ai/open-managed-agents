// Characterization (#545 §0.7 回归测试): Node usage / budget behaviour, pinned
// on 94d603e7 before the usage/budget convergence. Drives the managed runner
// and harness runtime through their public constructors with in-memory fakes
// and asserts the encoded runtime frames they publish.
import { describe, expect, it } from "vitest";
import type { Environment, Session } from "@open-managed-agents/managed-agents-application";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { createSessionClockRegistry } from "@open-managed-agents/shared";
import {
  beginModelEgress,
  completeModelEgress,
  createSessionBudgetGate,
  memoryListCostPicoStore,
  type SessionBudgetGate,
} from "../../../packages/managed-agents-domain/src/sessions/index.js";
import { DefaultNodeManagedSessionRunner } from "../../../packages/control-plane-node/src/lib/node-managed-session-runner.js";
import { ManagedNodeHarnessRuntime } from "../../../packages/control-plane-node/src/lib/node-managed-harness-runtime.js";

const T = Date.UTC(2026, 10, 1);
const PRICING = { version: 1, currency: "USD", input_per_mtok: "1", output_per_mtok: "1" } as const;
const environment = {
  id: "env_1", archivedAt: null, config: { type: "self_hosted" }, createdAt: new Date(T).toISOString(),
  description: null, metadata: {}, name: "Node", updatedAt: new Date(T).toISOString(),
} as unknown as Environment;

function session(usage: Record<string, unknown>, budget: unknown): Session {
  return {
    id: "session_usage", agent: { id: "agent_1", description: null, mcpServers: [], model: { id: "m" }, multiagent: null, name: "Agent", skills: [], system: null, tools: [], version: 1 },
    budget, environmentId: "env_1", metadata: {}, outcomeEvaluations: [], resources: [], stats: {}, status: "idle",
    title: null, usage, vaultIds: [], archivedAt: null, createdAt: new Date(T).toISOString(), updatedAt: new Date(T).toISOString(),
  } as unknown as Session;
}

type Frame = Record<string, any>;
const strip = ({ id: _id, processed_at: _processedAt, ...rest }: Frame) => rest;

async function execute(input: {
  session: Session;
  pricing?: typeof PRICING | null;
  harness: (context: { runtime: any; budget?: SessionBudgetGate | null }) => Promise<void>;
}): Promise<{ frames: Frame[]; gateStart: string | null }> {
  const frames: Frame[] = [];
  let n = 0;
  let gateStart: string | null = null;
  const runner = new DefaultNodeManagedSessionRunner({
    sessionClocks: createSessionClockRegistry(),
    outcomes: { evaluate: async () => { throw new Error("unexpected outcome evaluation"); } },
    confirmedTools: { execute: async () => { throw new Error("unexpected confirmed tool"); } },
    buildSandbox: async () => ({}) as SandboxExecutor,
    buildModel: async () => ({}),
    buildTools: async () => ({}),
    resolveModelPricing: async () => input.pricing === undefined ? PRICING : input.pricing,
    buildHarness: () => ({
      run: async (context: { runtime: any; budget?: SessionBudgetGate | null }) => {
        gateStart = context.budget?.list_cost_pico ?? null;
        await input.harness(context);
      },
    }),
    buildHarnessContext: async (context: unknown) => context,
    clock: { now: () => new Date(T) },
    ids: { nextEventId: () => `sevt_${++n}` },
    runtimeGenerations: { next: () => "runtime_1" },
  } as unknown as ConstructorParameters<typeof DefaultNodeManagedSessionRunner>[0]);
  const scope = { workspaceId: "workspace", sessionId: input.session.id };
  await runner.start({ ...scope, session: input.session, environment, initialEvents: [] } as never);
  const message = { id: "sevt_input", type: "user.message" as const, content: [{ type: "text" as const, text: "go" }], processedAt: new Date(T).toISOString() };
  await runner.accept({
    ...scope, session: input.session, environment, initialEvents: [], events: [message], historyEvents: [message],
    output: async (frame: Frame) => { frames.push(frame); },
  } as never);
  return { frames: frames.map(strip), gateStart };
}

const reportAndSpan = async ({ runtime }: { runtime: any }) => {
  await runtime.reportUsage(100, 50);
  runtime.broadcast({
    type: "span.model_request_end", model_request_start_id: "s",
    model_usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 7, cache_creation_input_tokens: 5 },
  });
};

const CACHED_USAGE = {
  input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 7,
  cache_creation: { ephemeral_five_minute_input_tokens: 5 },
};

function runtime(output: Frame[]) {
  let n = 0;
  return new ManagedNodeHarnessRuntime({
    initialEvents: [], events: [], sandbox: {} as SandboxExecutor,
    output: async (frame) => { output.push(frame as Frame); },
    clock: { now: () => new Date(T) }, ids: { nextEventId: () => `sevt_rt_${++n}` },
  });
}

describe("characterization: Node session usage and budget", () => {
  it("runtime: reportUsage and cache-bearing model spans publish the running snapshot; cache-free spans publish nothing", async () => {
    const output: Frame[] = [];
    const r = runtime(output);
    await reportAndSpan({ runtime: r });
    r.broadcast({ type: "span.model_request_end", model_request_start_id: "s2", model_usage: { input_tokens: 1, output_tokens: 1 } } as never);
    await r.drain();
    expect(output.map(strip).filter((frame) => frame.type === "session.usage")).toEqual([
      { type: "session.usage", usage: { input_tokens: 100, output_tokens: 50 } },
      { type: "session.usage", usage: CACHED_USAGE },
    ]);
  });

  it("runtime: a bound gate adds list_cost (rounded cents) and the exact list_cost_pico", async () => {
    const output: Frame[] = [];
    const r = runtime(output);
    r.setBudgetGate(createSessionBudgetGate({ amount: "300", currency: "USD" }, PRICING, memoryListCostPicoStore("1504000000000")));
    await r.reportUsage(1, 2);
    await r.drain();
    expect(strip(output[0]!)).toEqual({
      type: "session.usage",
      usage: { input_tokens: 1, output_tokens: 2, list_cost: { amount_minor: "150", currency: "USD" }, list_cost_pico: "1504000000000" },
    });
  });

  it("runner: budget_reached is thread idle -> usage(budget) -> session idle; every list-cost save publishes session.usage", async () => {
    const { frames, gateStart } = await execute({
      session: session({}, { amountMinor: "100", currency: "USD" }),
      harness: async (context) => {
        await reportAndSpan(context);
        completeModelEgress(context.budget, { input_tokens: 1_000_000 });
        beginModelEgress(context.budget);
      },
    });
    expect(gateStart).toBe("0");
    const zero = { list_cost: { amount_minor: "0", currency: "USD" }, list_cost_pico: "0" };
    const spent = { list_cost: { amount_minor: "100", currency: "USD" }, list_cost_pico: "1000000000000" };
    expect(frames.filter((frame) => frame.type !== "span.model_request_end")).toEqual([
      { type: "session.status_running" },
      { type: "session.usage", usage: { input_tokens: 100, output_tokens: 50, ...zero } },
      { type: "session.usage", usage: { ...CACHED_USAGE, ...zero } },
      { type: "session.usage", usage: { ...CACHED_USAGE, ...spent } },
      { type: "session.thread_status_idle", agent_name: "Agent", session_thread_id: "sthr_primary", stop_reason: { type: "budget_reached" } },
      { type: "session.usage", usage: { ...CACHED_USAGE, ...spent }, budget: { amount_minor: "100", currency: "USD" } },
      { type: "session.status_idle", stop_reason: { type: "budget_reached" } },
    ]);
  });

  it("runner: the gate resumes from session.usage list_cost_pico, else from the rounded cents", async () => {
    const budget = { amountMinor: "100", currency: "USD" };
    const exact = await execute({ session: session({ list_cost_pico: "123" }, budget), harness: async () => {} });
    expect(exact.gateStart).toBe("123");
    const cents = await execute({ session: session({ listCost: { amountMinor: "50", currency: "USD" } }, budget), harness: async () => {} });
    expect(cents.gateStart).toBe("500000000000");
  });

  it("runner: a budget on an unpriced model is inactive", async () => {
    const { frames, gateStart } = await execute({
      session: session({}, { amountMinor: "100", currency: "USD" }),
      pricing: null,
      harness: async (context) => {
        await reportAndSpan(context);
        completeModelEgress(context.budget, { input_tokens: 1_000_000 });
      },
    });
    expect(gateStart).toBeNull();
    expect(frames.at(-1)).toEqual({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
    expect(frames.filter((frame) => frame.type === "session.usage").at(-1)).toEqual({ type: "session.usage", usage: CACHED_USAGE });
  });

  // CF and Node differ here. CF accumulates token totals across turns in DO
  // state (usage-budget-characterization.test.ts in test/integration). Node at
  // 94d603e7 restarts every execution's ledger at 0, so the projected
  // Session.usage regresses to that execution's tokens. Kept: CF (cumulative,
  // the more complete behaviour, §0.7). Expected to fail until converged.
  it.fails("runner: token totals continue from the session's persisted usage (kept: Cloudflare, cumulative)", async () => {
    const { frames } = await execute({
      session: session({ inputTokens: 100, outputTokens: 50 }, null),
      harness: async ({ runtime: r }) => { await r.reportUsage(100, 50); },
    });
    expect(frames.find((frame) => frame.type === "session.usage")).toEqual({
      type: "session.usage", usage: { input_tokens: 200, output_tokens: 100 },
    });
  });
});
