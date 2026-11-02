import { describe, expect, it } from "vitest";
import {
  BUDGET_CREATE_ONLY,
  BUDGET_NOT_GREATER_THAN_CONSUMED,
  sessionPausedAtBudget,
  validateBudgetUpdate,
} from "../src/sessions/budget";

const session = (budget: string | null, consumed?: string, status = "idle") =>
  ({
    status,
    budget: budget === null ? null : { amountMinor: budget, currency: "USD" },
    usage: consumed === undefined ? {} : { listCost: { amountMinor: consumed, currency: "USD" } },
  }) as any;
const usd = (amountMinor: string) => ({ amountMinor, currency: "USD" }) as any;

describe("session budget update rules", () => {
  it("rejects adding a budget to a session created without one", () => {
    expect(validateBudgetUpdate(session(null), usd("500"))).toBe(BUDGET_CREATE_ONLY);
  });
  it("requires the new cap to exceed consumed list cost", () => {
    expect(validateBudgetUpdate(session("300", "330"), usd("330"))).toBe(BUDGET_NOT_GREATER_THAN_CONSUMED);
    expect(validateBudgetUpdate(session("300", "330"), usd("331"))).toBeNull();
  });
  it("allows removal and leaves other updates alone", () => {
    expect(validateBudgetUpdate(session("300", "330"), null)).toBeNull();
    expect(validateBudgetUpdate(session(null), undefined)).toBeNull();
  });
  it("is unaffected by missing pricing (no consumed cost = 0)", () => {
    expect(validateBudgetUpdate(session("300"), usd("1"))).toBeNull();
  });
});

describe("budget settle-only window", () => {
  it("is paused only at budget_reached with cap <= consumed", () => {
    expect(sessionPausedAtBudget(session("300", "330"), "budget_reached")).toBe(true);
    expect(sessionPausedAtBudget(session("300", "330"), "end_turn")).toBe(false);
  });
  it("resumes after the cap is raised or removed", () => {
    expect(sessionPausedAtBudget(session("400", "330"), "budget_reached")).toBe(false);
    expect(sessionPausedAtBudget(session(null, "330"), "budget_reached")).toBe(false);
  });
});
