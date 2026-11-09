import { describe, expect, it } from "vitest";
import {
  createSessionBudgetGate,
  turnSessionBudgetGate,
  gateExhausted,
  memoryListCostPicoStore,
  modelEgress,
  picoToCentsString,
  recordModelEgress,
  requestListCostPico,
  type ListPricing,
} from "../src/sessions/budget";

const pricing: ListPricing = {
  version: 1, currency: "USD", input_per_mtok: "3", output_per_mtok: "15",
  cache_read_per_mtok: "0.30", cache_write_per_mtok: "3.75",
};

describe("domain SessionBudgetGate", () => {
  it("shares charges and persistence without attributing a sibling stop to a completed turn", () => {
    const store = memoryListCostPicoStore();
    const parent = createSessionBudgetGate({amount:"1",currency:"USD"}, pricing, store)!;
    const fast = turnSessionBudgetGate(parent), expensive = turnSessionBudgetGate(parent);
    modelEgress(expensive)!.complete({input_tokens:1_000_000});
    expect(parent.list_cost_pico).toBe("3000000000000");
    expect(fast.list_cost_pico).toBe("3000000000000");
    expect(store.load()).toBe("3000000000000");
    expect(expensive.reached).toBe(true);
    expect(expensive.refused).not.toBe(true);
    expect(modelEgress(expensive)!.begin()).toBe(false);
    expect(expensive.refused).toBe(true);
    expect(parent.refused).toBe(true);
    expect(fast.refused).not.toBe(true);
    expect(fast.reached).toBe(false);
    expect(modelEgress(fast)!.begin()).toBe(false);
    expect(fast.reached).toBe(true);
  });
  it("prices one request exactly", () => {
    const pico = requestListCostPico(
      { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 },
      pricing,
    );
    expect(picoToCentsString(pico)).toBe("2205");
  });

  it("persists list_cost_pico only through the store port", () => {
    const store = memoryListCostPicoStore();
    const gate = createSessionBudgetGate({ amount: "300", currency: "USD" }, pricing, store)!;
    recordModelEgress(gate, { input_tokens: 500_000 });
    recordModelEgress(gate, { input_tokens: 600_000 });
    expect(picoToCentsString(BigInt(gate.list_cost_pico))).toBe("330");
    expect(store.load()).toBe(gate.list_cost_pico);
    expect(gateExhausted(gate)).toBe(true);
  });
});

describe("modelEgress (one path)", () => {
  it("begin refuses at cap and complete records via the store", () => {
    const store = memoryListCostPicoStore();
    const gate = createSessionBudgetGate({ amount: "300", currency: "USD" }, pricing, store)!;
    const egress = modelEgress(gate)!;
    expect(egress.begin()).toBe(true);
    egress.complete({ input_tokens: 500_000 }); // $1.50
    egress.complete({ input_tokens: 600_000 }); // $3.30
    expect(gateExhausted(gate)).toBe(true);
    expect(egress.begin()).toBe(false);
    expect(gate.reached).toBe(true);
    expect(store.load()).toBe(gate.list_cost_pico);
  });
});
