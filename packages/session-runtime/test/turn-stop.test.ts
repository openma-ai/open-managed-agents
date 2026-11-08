import { describe, expect, it } from "vitest";
import { decideTurnStop } from "../src/turn-stop";

describe("decideTurnStop", () => {
  it("ranks a parked call over the budget, and the budget over end_turn", () => {
    expect(decideTurnStop({ parkedOnClient: true, budgetReached: true })).toBe("requires_action");
    expect(decideTurnStop({ parkedOnClient: true, budgetReached: false })).toBe("requires_action");
    expect(decideTurnStop({ parkedOnClient: false, budgetReached: true })).toBe("budget_reached");
    expect(decideTurnStop({ parkedOnClient: false, budgetReached: false })).toBe("end_turn");
  });
});
