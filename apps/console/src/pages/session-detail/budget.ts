// Session budget helpers (official `budget.max_list_cost`, USD cents strings).
export interface WireAmount { amount: string; currency: string }

/** "$12.34" / "12.3" / "5" → "1234" / "1230" / "500"; null when invalid. */
export function dollarsToCents(input: string): string | null {
  const m = /^\$?\s*(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const cents = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  return cents > 0n ? cents.toString() : null;
}

export function centsToDollars(cents: string): string {
  const v = BigInt(cents);
  return `$${(v / 100n).toString()}.${(v % 100n).toString().padStart(2, "0")}`;
}

/** Session wire budget → cap amount, or null. */
export function readBudgetCap(budget: unknown): WireAmount | null {
  const b = budget as { max_list_cost?: WireAmount } | null | undefined;
  return b?.max_list_cost?.amount ? b.max_list_cost : null;
}

/** Recorded spend (egress list_cost) in cents, or null when unpriced. */
export function readListCostCents(usage: unknown): string | null {
  const cost = (usage as { list_cost?: WireAmount | null } | null | undefined)?.list_cost;
  return cost?.amount ? cost.amount : null;
}

/** Accumulated cost label; "unpriced" when the runtime reported no list_cost
 * (the model card has no pricing, so the budget is inactive). */
export function costLabel(usage: unknown, unpriced: string): string {
  const cost = (usage as { list_cost?: WireAmount | null } | null | undefined)?.list_cost;
  return cost?.amount ? centsToDollars(cost.amount) : unpriced;
}

/** PATCH body for setting/removing the cap. */
export function budgetUpdateBody(cents: string | null): { budget: unknown } {
  return {
    budget: cents === null
      ? null
      : { type: "limit", max_list_cost: { amount: cents, currency: "USD" } },
  };
}
