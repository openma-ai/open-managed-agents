// Session list-cost budget (official `budget.max_list_cost`).
//
// The budget is ACTIVE only when the session has a `max_list_cost` AND the
// session's model card has `pricing`. Either one missing = no enforcement, no
// error. The consumed cost is derived from history (every
// `span.model_request_end.model_usage` × the card's list prices), so CF and
// Node compute it identically and nothing extra is persisted.
//
// Exact amounts use picodollars (1e-12 USD) as BigInt: price strings are
// parsed to micro-USD per million tokens, so tokens × price is exact.
import type { ModelPricing, SessionEvent } from "@open-managed-agents/api-types";
import { parseUsdPrice } from "@open-managed-agents/model-cards-store";

export { parseUsdPrice };

const PICO_PER_CENT = 10_000_000_000n; // 1e10

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Exact list cost of one model request, in picodollars. Cache prices default
 * to the input price when the card omits them. */
export function requestListCostPico(usage: TokenUsage, pricing: ModelPricing): bigint {
  const input = parseUsdPrice(pricing.input_per_mtok);
  const output = parseUsdPrice(pricing.output_per_mtok);
  const cacheRead = pricing.cache_read_per_mtok ? parseUsdPrice(pricing.cache_read_per_mtok) : input;
  const cacheWrite = pricing.cache_write_per_mtok ? parseUsdPrice(pricing.cache_write_per_mtok) : input;
  const n = (v: number | undefined) => BigInt(Math.max(0, Math.trunc(v ?? 0)));
  return n(usage.input_tokens) * input
    + n(usage.output_tokens) * output
    + n(usage.cache_read_input_tokens) * cacheRead
    + n(usage.cache_creation_input_tokens) * cacheWrite;
}

/** Session consumed list cost (picodollars) from its event history. */
export function consumedListCostPico(
  events: readonly SessionEvent[],
  pricing: ModelPricing,
): bigint {
  let total = 0n;
  for (const event of events) {
    if (event.type !== "span.model_request_end") continue;
    const usage = (event as { model_usage?: TokenUsage }).model_usage;
    if (usage) total += requestListCostPico(usage, pricing);
  }
  return total;
}

/** Runtime-history `usage.list_cost` for an exact consumed cost. */
export function runtimeListCost(pico: bigint): { amount_minor: string; currency: "USD" } {
  return { amount_minor: picoToCentsString(pico), currency: "USD" };
}

/** Picodollars → whole cents (half-up), as the wire's integer string. */
export function picoToCentsString(pico: bigint): string {
  return ((pico + PICO_PER_CENT / 2n) / PICO_PER_CENT).toString();
}

export function centsToPico(cents: string): bigint {
  return BigInt(cents) * PICO_PER_CENT;
}

/** Wire budget, `{ amount: "<cents>", currency: "USD" }`. */
export interface BudgetAmount { amount: string; currency: string }

/**
 * The per-execution budget gate handed to a harness. Null when inactive
 * (no budget, or no pricing on the model card).
 */
export interface SessionBudgetGate {
  maxListCost: BudgetAmount;
  pricing: ModelPricing;
  /** Set by the harness when it skipped a model call at the cap. */
  reached: boolean;
}

export function createSessionBudgetGate(
  budget: BudgetAmount | null | undefined,
  pricing: ModelPricing | null | undefined,
): SessionBudgetGate | null {
  if (!budget || !pricing) return null;
  if (budget.currency !== "USD" || !/^(0|[1-9]\d*)$/.test(budget.amount)) return null;
  return { maxListCost: { ...budget }, pricing, reached: false };
}

/** Pre-request check: true when the consumed list cost has reached the cap.
 * The request that crosses the cap is allowed to finish; the NEXT one stops. */
export function budgetExhausted(
  gate: SessionBudgetGate | null | undefined,
  events: readonly SessionEvent[],
): boolean {
  if (!gate) return false;
  return consumedListCostPico(events, gate.pricing) >= centsToPico(gate.maxListCost.amount);
}

/** The official stop sequence when a session reaches its budget:
 * thread_status_idle → session.usage → session.status_idle, each with
 * stop_reason budget_reached. Caller stamps ids/timestamps. */
export function budgetReachedEvents(input: {
  sessionThreadId?: string | null;
  usage: Record<string, unknown>;
  budget: BudgetAmount;
}): SessionEvent[] {
  const stop = { type: "budget_reached" as const };
  return [
    {
      type: "session.thread_status_idle",
      ...(input.sessionThreadId ? { session_thread_id: input.sessionThreadId } : {}),
      stop_reason: stop,
    },
    {
      type: "session.usage",
      usage: input.usage,
      // Runtime history carries the domain MonetaryAmount shape snake-cased
      // (see encodeRuntimeHistoryEvent); the API mapper renders the official
      // `{type:"limit", max_list_cost}` wire.
      budget: { amount_minor: input.budget.amount, currency: input.budget.currency },
    },
    { type: "session.status_idle", stop_reason: stop },
  ] as unknown as SessionEvent[];
}


/** Mutable session-wide list of `span.model_request_end` frames for budget.
 * Node keeps harness history primary-thread-only (so the parent model does not
 * see subagent turns as context) but seeds and observes this ledger from every
 * thread so `list_cost` matches Cloudflare's full-session SqliteHistory. */
export class SessionListCostLedger {
  private readonly ends: SessionEvent[] = [];

  seed(events: readonly SessionEvent[]): void {
    for (const event of events) this.observe(event);
  }

  observe(event: SessionEvent): void {
    if (event.type !== "span.model_request_end") return;
    if (!(event as { model_usage?: TokenUsage }).model_usage) return;
    this.ends.push(event);
  }

  events(): readonly SessionEvent[] {
    return this.ends;
  }

  consumedPico(pricing: ModelPricing): bigint {
    return consumedListCostPico(this.ends, pricing);
  }
}
