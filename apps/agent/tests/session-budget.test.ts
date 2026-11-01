import { describe, expect, it } from "vitest";
import type { ModelPricing } from "@open-managed-agents/api-types";
import {
  gateExhausted,
  meterPiRuntime,
  recordModelEgress,
  budgetReachedEvents,
  createSessionBudgetGate,
  picoToCentsString,
  requestListCostPico,
} from "../src/harness/budget";

const pricing: ModelPricing = {
  version: 1,
  currency: "USD",
  input_per_mtok: "3",
  output_per_mtok: "15",
  cache_read_per_mtok: "0.30",
  cache_write_per_mtok: "3.75",
};

describe("session list-cost budget", () => {
  it("prices usage exactly per million tokens", () => {
    // 1M in ($3) + 1M out ($15) + 1M cache read ($0.30) + 1M cache write ($3.75)
    const pico = requestListCostPico(
      { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 },
      pricing,
    );
    expect(picoToCentsString(pico)).toBe("2205");
  });

  it("defaults cache prices to the input price and rounds to the cent", () => {
    const p: ModelPricing = { version: 1, currency: "USD", input_per_mtok: "1", output_per_mtok: "2" };
    expect(picoToCentsString(requestListCostPico({ cache_read_input_tokens: 1e6 }, p))).toBe("100");
    expect(picoToCentsString(requestListCostPico({ input_tokens: 4999 }, p))).toBe("0");
    expect(picoToCentsString(requestListCostPico({ input_tokens: 5000 }, p))).toBe("1");
  });

  it("is inactive unless BOTH budget and pricing are configured", () => {
    expect(createSessionBudgetGate(null, pricing)).toBeNull();
    expect(createSessionBudgetGate({ amount: "100", currency: "USD" }, null)).toBeNull();
    expect(gateExhausted(null)).toBe(false);
  });

  it("gates at egress before the next request once consumed >= cap", () => {
    const gate = createSessionBudgetGate({ amount: "300", currency: "USD" }, pricing)!;
    recordModelEgress(gate, { input_tokens: 500_000 }); // $1.50
    expect(gateExhausted(gate)).toBe(false);
    recordModelEgress(gate, { input_tokens: 600_000 }); // crossing request completes: $3.30
    expect(picoToCentsString(gate.consumedPico)).toBe("330");
    expect(gateExhausted(gate)).toBe(true);
  });

  it("seeds from the persisted egress counter and persists each egress", () => {
    const persisted: bigint[] = [];
    const gate = createSessionBudgetGate({ amount: "300", currency: "USD" }, pricing, {
      consumedPico: (250n * 10_000_000_000n).toString(),
      onEgress: (pico) => persisted.push(pico),
    })!;
    recordModelEgress(gate, { input_tokens: 200_000 }); // +$0.60
    expect(picoToCentsString(gate.consumedPico)).toBe("310");
    expect(persisted).toEqual([gate.consumedPico]);
    expect(gateExhausted(gate)).toBe(true);
  });

  it("meters every request through one shared egress (parent + subagent)", async () => {
    const gate = createSessionBudgetGate({ amount: "300", currency: "USD" }, pricing)!;
    const usage = { input: 600_000, output: 0, cacheRead: 0, cacheWrite: 0 }; // $1.80
    const fakeModels = {
      completeSimple: async () => ({ usage }),
      streamSimple: (_m: unknown, _c: unknown, options?: { signal?: AbortSignal }) => ({
        aborted: options?.signal?.aborted ?? false,
        result: async () => ({ usage }),
      }),
    };
    const parent = meterPiRuntime({ models: fakeModels }, gate);
    const child = meterPiRuntime({ models: fakeModels }, gate);
    await parent.models.completeSimple();
    await child.models.streamSimple(null, null, {}).result();
    await Promise.resolve();
    expect(picoToCentsString(gate.consumedPico)).toBe("360");
    // At the cap: streams are issued pre-aborted, completes refuse.
    expect(parent.models.streamSimple(null, null, {}).aborted).toBe(true);
    await expect(child.models.completeSimple()).rejects.toThrow("session budget reached");
    expect(gate.reached).toBe(true);
  });

  it("emits thread_status_idle -> session.usage -> status_idle(budget_reached)", () => {
    const events = budgetReachedEvents({
      sessionThreadId: "sthr_primary",
      usage: { list_cost: { amount_minor: "330", currency: "USD" } },
      budget: { amount: "300", currency: "USD" },
    }) as unknown as Array<Record<string, any>>;
    expect(events.map((e) => e.type)).toEqual([
      "session.thread_status_idle",
      "session.usage",
      "session.status_idle",
    ]);
    expect(events[0].stop_reason).toEqual({ type: "budget_reached" });
    expect(events[1].budget).toEqual({ amount_minor: "300", currency: "USD" });
    expect(events[2].stop_reason).toEqual({ type: "budget_reached" });
  });
});
