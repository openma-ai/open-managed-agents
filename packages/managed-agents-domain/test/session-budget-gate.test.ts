import { describe, expect, it } from "vitest";
import {
  createSessionBudgetGate,
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
