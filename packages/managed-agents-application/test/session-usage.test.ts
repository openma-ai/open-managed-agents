import { describe, expect, it } from "vitest";
import {
  activeModelCardPricing,
  applyModelEgressRequest,
  budgetReachedStopEvents,
  createSessionUsageMeter,
  memorySessionUsageStore,
  MODEL_EGRESS_ACTION_REQUIRED,
  openSessionBudgetGate,
  parseModelEgressRequest,
  sessionTokenTotalsFromUsage,
  sessionUsageSnapshot,
  sumModelSpanUsage,
  tokenTotalsToApiUsage,
} from "../src/sessions/budget";
import { memoryListCostPicoStore } from "@open-managed-agents/domain/sessions";

const PRICING = { version: 1, currency: "USD", input_per_mtok: "1", output_per_mtok: "1" } as const;
const BUDGET = { amountMinor: "100", currency: "USD" as const };
const totals = (input: number, output: number, cacheRead = 0, cacheCreation = 0) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation,
});

describe("session usage (application, shared by Cloudflare and Node)", () => {
  it("snapshot omits zero cache buckets and adds list cost only with a gate", async () => {
    expect(sessionUsageSnapshot(totals(1, 2), null)).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(sessionUsageSnapshot(totals(1, 2, 3, 4), null)).toEqual({
      inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreation: { ephemeralFiveMinuteInputTokens: 4 },
    });
    const gate = await openSessionBudgetGate({ session: { budget: BUDGET, usage: undefined }, pricing: async () => PRICING, store: memoryListCostPicoStore("1504000000000") });
    expect(sessionUsageSnapshot(totals(1, 2), gate)).toEqual({
      inputTokens: 1, outputTokens: 2, listCost: { amountMinor: "150", currency: "USD" }, list_cost_pico: "1504000000000",
    });
  });

  it("seeds token totals from a persisted Session.usage and round-trips the wire usage", () => {
    const seed = sessionTokenTotalsFromUsage({ inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 7, cacheCreation: { ephemeralFiveMinuteInputTokens: 5 } });
    expect(seed).toEqual(totals(100, 50, 7, 5));
    expect(sessionTokenTotalsFromUsage(null)).toEqual(totals(0, 0));
    expect(tokenTotalsToApiUsage(totals(1, 2))).toEqual({ input_tokens: 1, output_tokens: 2 });
    expect(tokenTotalsToApiUsage(totals(1, 2, 3, 4))).toEqual({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 });
    const meter = createSessionUsageMeter(memorySessionUsageStore({ threads: { t: seed }, session: { input_tokens: 100, output_tokens: 50 } }));
    meter.credit("t", { input_tokens: 100, output_tokens: 50 });
    expect(meter.thread("t")).toEqual(totals(200, 100, 7, 5));
  });

  it("sums every model span in an event log (cold reads, CF budget stop)", () => {
    expect(sumModelSpanUsage([
      { type: "span.model_request_end", model_usage: { input_tokens: 30, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } },
      { type: "agent.message" },
      { type: "span.model_request_end", model_usage: { input_tokens: 20, output_tokens: 6 } },
      { type: "span.model_request_end", model_usage: null },
    ])).toEqual(totals(50, 10, 2, 1));
  });

  it("archived and unpriced model cards meter nothing", () => {
    expect(activeModelCardPricing(null)).toBeNull();
    expect(activeModelCardPricing({ archived_at: null, pricing: PRICING })).toEqual(PRICING);
    expect(activeModelCardPricing({ pricing: PRICING })).toEqual(PRICING);
    expect(activeModelCardPricing({ archived_at: "2026-11-01T00:00:00Z", pricing: PRICING })).toBeNull();
    expect(activeModelCardPricing({ archived_at: null, pricing: null })).toBeNull();
  });

  it("opens the gate only with a budget and pricing; pricing is looked up only with a budget", async () => {
    let lookups = 0;
    const pricing = async () => { lookups += 1; return PRICING; };
    expect(await openSessionBudgetGate({ session: { budget: null, usage: undefined }, pricing, store: memoryListCostPicoStore() })).toBeNull();
    expect(lookups).toBe(0);
    expect(await openSessionBudgetGate({ session: { budget: BUDGET, usage: undefined }, pricing: async () => null, store: memoryListCostPicoStore() })).toBeNull();
    const gate = await openSessionBudgetGate({ session: { budget: BUDGET, usage: undefined }, pricing, store: memoryListCostPicoStore() });
    expect(lookups).toBe(1);
    expect(gate).toMatchObject({ maxListCost: { amount: "100", currency: "USD" }, list_cost_pico: "0", reached: false });
  });

  it("resumes consumed cost from the store, else the Session's exact pico, else its rounded cents (kept: Node)", async () => {
    const open = (usage: Record<string, unknown> | undefined, stored?: string) =>
      openSessionBudgetGate({ session: { budget: BUDGET, usage: usage as never }, pricing: async () => PRICING, store: memoryListCostPicoStore(stored) });
    expect((await open({ list_cost_pico: "123" }, "456"))!.list_cost_pico).toBe("456");
    expect((await open({ list_cost_pico: "123" }))!.list_cost_pico).toBe("123");
    expect((await open({ listCost: { amountMinor: "50", currency: "USD" } }))!.list_cost_pico).toBe("500000000000");
    expect((await open(undefined))!.list_cost_pico).toBe("0");
    expect((await open({ list_cost_pico: "123" }, "not-a-number"))!.list_cost_pico).toBe("123");
  });

  it("the gate persists each egress through the platform store", async () => {
    const store = memoryListCostPicoStore();
    const gate = await openSessionBudgetGate({ session: { budget: BUDGET, usage: undefined }, pricing: async () => PRICING, store });
    applyModelEgressRequest(gate, { action: "complete", usage: { input_tokens: 1_000_000 } });
    expect(store.load()).toBe("1000000000000");
  });

  it("budget stop: thread idle -> usage(budget) -> session idle, all budget_reached", () => {
    const usage = { inputTokens: 1, outputTokens: 2 };
    expect(budgetReachedStopEvents({ agentName: "Agent", sessionThreadId: "sthr_primary", usage, budget: { amount: "100", currency: "USD" } })).toEqual([
      { type: "session.thread_status_idle", agentName: "Agent", sessionThreadId: "sthr_primary", stopReason: { type: "budget_reached" } },
      { type: "session.usage", usage, budget: { amountMinor: "100", currency: "USD" } },
      { type: "session.status_idle", stopReason: { type: "budget_reached" } },
    ]);
    expect(budgetReachedStopEvents({ sessionThreadId: null, usage, budget: { amount: "1", currency: "USD" } })[0])
      .toEqual({ type: "session.thread_status_idle", stopReason: { type: "budget_reached" } });
  });

  it("/model-egress protocol: parse, inactive allow, begin and complete", async () => {
    expect(parseModelEgressRequest(null)).toBeNull();
    expect(parseModelEgressRequest({ action: "nope" })).toBeNull();
    expect(parseModelEgressRequest({ action: "begin" })).toEqual({ action: "begin" });
    expect(parseModelEgressRequest({ action: "complete" })).toEqual({ action: "complete", usage: {} });
    expect(parseModelEgressRequest({ action: "complete", usage: { input_tokens: 1 } })).toEqual({ action: "complete", usage: { input_tokens: 1 } });
    expect(MODEL_EGRESS_ACTION_REQUIRED).toBe("action required (begin|complete)");
    expect(applyModelEgressRequest(null, { action: "begin" })).toEqual({ active: false, allowed: true, list_cost_pico: null });
    const gate = await openSessionBudgetGate({ session: { budget: BUDGET, usage: undefined }, pricing: async () => PRICING, store: memoryListCostPicoStore() });
    expect(applyModelEgressRequest(gate, { action: "begin" })).toEqual({ active: true, allowed: true, reached: false, list_cost_pico: "0" });
    expect(applyModelEgressRequest(gate, { action: "complete", usage: { input_tokens: 1_000_000 } }))
      .toEqual({ active: true, reached: true, list_cost_pico: "1000000000000" });
    expect(applyModelEgressRequest(gate, { action: "begin" })).toEqual({ active: true, allowed: false, reached: true, list_cost_pico: "1000000000000" });
  });
});
