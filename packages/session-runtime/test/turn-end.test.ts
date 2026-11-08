import { describe, expect, it } from "vitest";
import { finishTurn, type TurnEndPort } from "../src/turn-end";

function port() {
  const calls: string[] = [];
  const end: TurnEndPort = {
    requiresAction: () => { calls.push("requires_action"); },
    budgetReached: () => { calls.push("budget_reached"); },
    endTurn: () => { calls.push("end_turn"); },
  };
  return { end, calls };
}

describe("finishTurn", () => {
  it("ranks requires_action over budget_reached over end_turn and renders only the chosen ending", () => {
    for (const [parkedOnClient, budgetReached, expected] of [
      [true, true, "requires_action"],
      [true, false, "requires_action"],
      [false, true, "budget_reached"],
      [false, false, "end_turn"],
    ] as const) {
      const { end, calls } = port();
      expect(finishTurn({ parkedOnClient, budgetReached }, end)).toBe(expected);
      expect(calls).toEqual([expected]);
    }
  });
});
