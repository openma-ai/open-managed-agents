// Characterization (#545 §0.7 回归测试): Cloudflare SessionDO usage / budget
// behaviour, pinned on 94d603e7 before the usage/budget convergence. Drives
// only the public managed API plus the DO's internal HTTP surface; no private
// methods. These assertions must hold unchanged on the converged code.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import { beginModelEgress, completeModelEgress } from "@open-managed-agents/domain/sessions";

const SPEND_HARNESS = "characterization-usage-budget-spend";
const REPORT_HARNESS = "characterization-usage-report";

// One turn: harness usage report, one model span with cache buckets, one
// metered egress that crosses the cap, then a refused egress.
registerHarness(SPEND_HARNESS, () => ({
  async run(ctx: any) {
    await ctx.runtime.reportUsage?.(100, 50);
    ctx.runtime.broadcast({
      type: "span.model_request_end",
      model_request_start_id: "sevt_characterization_start",
      model_usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 7, cache_creation_input_tokens: 5 },
    });
    completeModelEgress(ctx.budget, { input_tokens: 1_000_000 }); // $1 at $1/Mtok
    beginModelEgress(ctx.budget); // refused: at the cap
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "spent" }] });
  },
}));

registerHarness(REPORT_HARNESS, () => ({
  async run(ctx: any) {
    await ctx.runtime.reportUsage?.(100, 50);
    ctx.runtime.broadcast({
      type: "span.model_request_end",
      model_request_start_id: "sevt_characterization_report",
      model_usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 3 },
    });
    ctx.runtime.broadcast({ type: "agent.message", content: [{ type: "text", text: "reported" }] });
  },
}));

const H = { "x-api-key": "test-key", "content-type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" };
const call = (path: string, body?: unknown) => exports.default.fetch(new Request(`http://localhost${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: H,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}));

async function createSession(input: { harness: string; priced: boolean; budgetCents?: string }) {
  const model = `characterization-model-${crypto.randomUUID().slice(0, 8)}`;
  const card = await call("/v1/oma/model_cards", {
    provider: "ant",
    model_id: model,
    api_key: "sk-ant-test-key",
    ...(input.priced ? { pricing: { version: 1, currency: "USD", input_per_mtok: "1", output_per_mtok: "1" } } : {}),
  });
  expect(card.status).toBe(201);
  const agent = await (await call("/v1/oma/agents", { name: "Characterization", model, _oma: { harness: input.harness } })).json() as { id: string };
  const environment = await (await call("/v1/environments", { name: `characterization-${crypto.randomUUID()}`, config: { type: "cloud" } })).json() as { id: string };
  const created = await call("/v1/sessions", {
    agent: agent.id,
    environment_id: environment.id,
    ...(input.budgetCents === undefined ? {} : { budget: { type: "limit", max_list_cost: { amount: input.budgetCents, currency: "USD" } } }),
  });
  expect(created.status).toBe(201);
  const session = await created.json() as { id: string };
  const stub = env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify(["default", session.id])));
  return { id: session.id, stub };
}

async function turn(sessionId: string, text: string, idleCount: number): Promise<Array<Record<string, any>>> {
  const sent = await call(`/v1/sessions/${sessionId}/events`, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
  expect(sent.status).toBe(200);
  let events: Array<Record<string, any>> = [];
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    events = ((await (await call(`/v1/sessions/${sessionId}/events?limit=200`)).json()) as { data: Array<Record<string, any>> }).data;
    if (events.filter((event) => event.type === "session.status_idle").length >= idleCount) break;
  }
  return events;
}

function strip(event: Record<string, any>) {
  const { id: _id, processed_at: _processedAt, ...rest } = event;
  return rest;
}

describe("characterization: Cloudflare session usage and budget", () => {
  it("budget_reached: thread idle -> usage snapshot -> session idle, egress meter persisted in DO state", async () => {
    const { id, stub } = await createSession({ harness: SPEND_HARNESS, priced: true, budgetCents: "100" });
    const events = await turn(id, "spend", 1);
    const types = events.map((event) => event.type);
    // Intentional change (platform parity gate): the harness usage report and
    // the model span with cache buckets each publish a session.usage snapshot,
    // as on Node (shared reportSessionUsage / reportModelSpanUsage; SDK
    // BetaManagedAgentsSessionUsageEvent "Periodic snapshot of the session's
    // cumulative usage"). Before, CF emitted only the budget_reached one.
    // The CF list-cost store still only persists DO state; it does not emit a
    // per-egress session.usage (Node does). Kept as is: each platform's
    // store adapter keeps its own side effects.
    expect(types.filter((type) => type === "session.usage")).toHaveLength(3);
    expect(events.filter((event) => event.type === "session.usage").slice(0, 2).map(strip)).toMatchObject([
      { usage: { input_tokens: 100, output_tokens: 50, list_cost: { amount: "0", currency: "USD" } } },
      {
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 7,
          cache_creation: { ephemeral_5m_input_tokens: 5 },
          list_cost: { amount: "0", currency: "USD" },
        },
      },
    ]);
    expect(events.slice(-3).map(strip)).toEqual([
      { type: "session.thread_status_idle", agent_name: "Characterization", session_thread_id: "sthr_primary", stop_reason: { type: "budget_reached" } },
      {
        type: "session.usage",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 7,
          cache_creation: { ephemeral_5m_input_tokens: 5 },
          list_cost: { amount: "100", currency: "USD" },
        },
        budget: { type: "limit", max_list_cost: { amount: "100", currency: "USD" } },
      },
      { type: "session.status_idle", stop_reason: { type: "budget_reached" } },
    ]);
    const session = await (await call(`/v1/sessions/${id}`)).json() as Record<string, any>;
    expect(session.status).toBe("idle");
    expect(session.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 7,
      cache_creation: { ephemeral_5m_input_tokens: 5 },
      list_cost: { amount: "100", currency: "USD" },
    });
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.state.input_tokens).toBe(100);
      expect(instance.state.output_tokens).toBe(50);
      expect(instance.state.list_cost_pico).toBe("1000000000000");
      expect(instance.state.thread_usage).toEqual({
        sthr_primary: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 },
      });
    });
    // /model-egress (main inference-proxy transport) reads the same meter.
    const begin = await stub.fetch(new Request("http://internal/model-egress", { method: "POST", body: JSON.stringify({ action: "begin" }) }));
    expect(await begin.json()).toEqual({ active: true, allowed: false, reached: true, list_cost_pico: "1000000000000" });
    const complete = await stub.fetch(new Request("http://internal/model-egress", { method: "POST", body: JSON.stringify({ action: "complete", usage: { output_tokens: 10_000 } }) }));
    expect(await complete.json()).toEqual({ active: true, reached: true, list_cost_pico: "1010000000000" });
    const status = await stub.fetch(new Request("http://internal/status"));
    expect((await status.json() as { usage: unknown }).usage).toEqual({ input_tokens: 100, output_tokens: 50 });
  }, 60_000);

  it("token totals accumulate across turns in DO state; per-thread cache buckets come from model spans", async () => {
    const { id, stub } = await createSession({ harness: REPORT_HARNESS, priced: false });
    await turn(id, "one", 1);
    await turn(id, "two", 2);
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.state.input_tokens).toBe(200);
      expect(instance.state.output_tokens).toBe(100);
      expect(instance.state.thread_usage.sthr_primary).toEqual({
        input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 6,
      });
    });
    // No budget → inactive meter; begin always allows.
    const begin = await stub.fetch(new Request("http://internal/model-egress", { method: "POST", body: JSON.stringify({ action: "begin" }) }));
    expect(await begin.json()).toEqual({ active: false, allowed: true, list_cost_pico: null });
    const invalid = await stub.fetch(new Request("http://internal/model-egress", { method: "POST", body: JSON.stringify({ action: "nope" }) }));
    expect(invalid.status).toBe(400);
  }, 60_000);

  it("a budget on an unpriced model card is inactive (no gate, no budget stop)", async () => {
    const { id, stub } = await createSession({ harness: SPEND_HARNESS, priced: false, budgetCents: "100" });
    const events = await turn(id, "spend", 1);
    expect(events.at(-1)).toMatchObject({ type: "session.status_idle", stop_reason: { type: "end_turn" } });
    const begin = await stub.fetch(new Request("http://internal/model-egress", { method: "POST", body: JSON.stringify({ action: "begin" }) }));
    expect(await begin.json()).toEqual({ active: false, allowed: true, list_cost_pico: null });
  }, 60_000);

  it("POST /usage credits the thread and echoes session-wide input/output only", async () => {
    const { stub } = await createSession({ harness: REPORT_HARNESS, priced: false });
    const first = await stub.fetch(new Request("http://internal/usage", {
      method: "POST",
      body: JSON.stringify({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, session_thread_id: "sthr_child" }),
    }));
    expect(await first.json()).toEqual({ input_tokens: 10, output_tokens: 4 });
    const second = await stub.fetch(new Request("http://internal/usage", {
      method: "POST",
      body: JSON.stringify({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 9 }),
    }));
    expect(await second.json()).toEqual({ input_tokens: 11, output_tokens: 5 });
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.state.thread_usage).toEqual({
        sthr_child: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 2 },
        sthr_primary: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 9, cache_read_input_tokens: 0 },
      });
    });
  }, 60_000);
});
