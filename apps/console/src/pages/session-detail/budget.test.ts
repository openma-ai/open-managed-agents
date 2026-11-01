import { describe, expect, it } from "vitest";
import { budgetUpdateBody, centsToDollars, costLabel, dollarsToCents, readBudgetCap } from "./budget";

describe("session budget field", () => {
  it("converts dollars to cents", () => {
    expect(dollarsToCents("$12.34")).toBe("1234");
    expect(dollarsToCents("5")).toBe("500");
    expect(dollarsToCents("0.5")).toBe("50");
    expect(dollarsToCents("0")).toBeNull();
    expect(dollarsToCents("1.234")).toBeNull();
    expect(centsToDollars("1205")).toBe("$12.05");
  });
  it("reads cap, shows cost or unpriced", () => {
    expect(readBudgetCap({ type: "limit", max_list_cost: { amount: "500", currency: "USD" } })?.amount).toBe("500");
    expect(readBudgetCap(null)).toBeNull();
    expect(costLabel({ list_cost: { amount: "330", currency: "USD" } }, "unpriced")).toBe("$3.30");
    expect(costLabel({ input_tokens: 10 }, "unpriced")).toBe("unpriced");
  });
  it("builds the PATCH body", () => {
    expect(budgetUpdateBody("700")).toEqual({ budget: { type: "limit", max_list_cost: { amount: "700", currency: "USD" } } });
    expect(budgetUpdateBody(null)).toEqual({ budget: null });
  });
});
