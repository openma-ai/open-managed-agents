import { describe, expect, it } from "vitest";
import type { ModelPricing, SessionEvent } from "@open-managed-agents/api-types";
import {
  budgetExhausted,
  budgetReachedEvents,
  consumedListCostPico,
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
const req = (usage: Record<string, number>) =>
  ({ type: "span.model_request_end", model_usage: usage }) as unknown as SessionEvent;

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
    expect(budgetExhausted(null, [req({ input_tokens: 1e9 })])).toBe(false);
  });

  it("gates before the next request once consumed >= cap", () => {
    const gate = createSessionBudgetGate({ amount: "300", currency: "USD" }, pricing)!;
    const history = [req({ input_tokens: 500_000 })]; // $1.50
    expect(budgetExhausted(gate, history)).toBe(false);
    history.push(req({ input_tokens: 600_000 })); // crossing request completes: $3.30
    expect(consumedListCostPico(history, pricing) > 0n).toBe(true);
    expect(budgetExhausted(gate, history)).toBe(true);
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
