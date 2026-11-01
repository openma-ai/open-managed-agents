// Session list-cost budget (official `budget.max_list_cost`).
//
// ACTIVE only when the session has a max_list_cost AND the model card has
// pricing. Bookkeeping lives at MODEL EGRESS: SessionBudgetGate is the
// session-scoped meter. CF and Node differ ONLY in where the pico counter is
// stored (Durable Object `list_cost_pico` vs `session.usage.listCostPico`);
// adapters load/save that total. Gate, accounting, and budget_reached are
// identical domain code — no CF- or Node-specific budget rules.
//
// Picodollars (1e-12 USD) as BigInt: price strings parse to micro-USD per
// million tokens, so tokens × price is exact.

const PICO_PER_CENT = 10_000_000_000n; // 1e10
const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/;

/** List prices used for session list_cost. Same shape as model-card pricing. */
export interface ListPricing {
  version: 1;
  currency: "USD";
  effective_at?: string;
  input_per_mtok: string;
  output_per_mtok: string;
  cache_read_per_mtok?: string;
  cache_write_per_mtok?: string;
}

/** "3.75" USD → 3_750_000 micro-USD. Throws on a malformed price. */
export function parseUsdPrice(value: string): bigint {
  const m = DECIMAL.exec(value);
  if (!m) {
    throw new Error(
      `invalid price "${value}": expected a non-negative decimal with at most 6 fraction digits`,
    );
  }
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Exact list cost of one model request, in picodollars. */
export function requestListCostPico(usage: TokenUsage, pricing: ListPricing): bigint {
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

/** Runtime-history `usage.list_cost` for an exact consumed cost (snake_case wire). */
export function runtimeListCost(pico: bigint): { amount_minor: string; currency: "USD" } {
  return { amount_minor: picoToCentsString(pico), currency: "USD" };
}

export function picoToCentsString(pico: bigint): string {
  return ((pico + PICO_PER_CENT / 2n) / PICO_PER_CENT).toString();
}

export function centsToPico(cents: string): bigint {
  return BigInt(cents) * PICO_PER_CENT;
}

/** Wire budget amount, `{ amount: "<cents>", currency: "USD" }`. */
export interface BudgetAmount { amount: string; currency: string }

/**
 * Session-scoped egress meter + budget gate. Parent and subagents of one
 * session share ONE instance. Null when inactive.
 */
export interface SessionBudgetGate {
  maxListCost: BudgetAmount;
  pricing: ListPricing;
  /** Exact consumed list cost (picodollars), maintained only at egress. */
  consumedPico: bigint;
  /** Persist hook after each recorded egress. */
  onEgress?: (consumedPico: bigint) => void;
  /** Set when egress refused a model call at the cap. */
  reached: boolean;
}

export function createSessionBudgetGate(
  budget: BudgetAmount | null | undefined,
  pricing: ListPricing | null | undefined,
  seed: { consumedPico?: string | bigint | null; onEgress?: (consumedPico: bigint) => void } = {},
): SessionBudgetGate | null {
  if (!budget || !pricing) return null;
  if (budget.currency !== "USD" || !/^(0|[1-9]\d*)$/.test(budget.amount)) return null;
  const raw = seed.consumedPico;
  const consumedPico = typeof raw === "bigint"
    ? raw
    : typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
  return {
    maxListCost: { ...budget },
    pricing,
    consumedPico,
    ...(seed.onEgress && { onEgress: seed.onEgress }),
    reached: false,
  };
}

/** Pre-request check at egress: true once consumed >= cap.
 * The request that crosses the cap finishes; the NEXT one stops. */
export function gateExhausted(gate: SessionBudgetGate | null | undefined): boolean {
  if (!gate) return false;
  return gate.consumedPico >= centsToPico(gate.maxListCost.amount);
}

/** @deprecated Prefer gateExhausted; kept for the deprecated default-loop. */
export function budgetExhausted(
  gate: SessionBudgetGate | null | undefined,
  _events?: readonly unknown[],
): boolean {
  return gateExhausted(gate);
}

/** Record one completed model request at egress. */
export function recordModelEgress(
  gate: SessionBudgetGate | null | undefined,
  usage: TokenUsage,
): void {
  if (!gate) return;
  gate.consumedPico += requestListCostPico(usage, gate.pricing);
  gate.onEgress?.(gate.consumedPico);
}

/** Thrown when a non-streaming egress call is refused at the cap. */
export class SessionBudgetReachedError extends Error {
  constructor() {
    super("session budget reached");
    this.name = "SessionBudgetReachedError";
  }
}

/** Unstamped stop sequence: thread_idle → usage → status_idle. Caller stamps. */
export interface BudgetReachedFrame {
  type: string;
  [key: string]: unknown;
}

export function budgetReachedEvents(input: {
  sessionThreadId?: string | null;
  usage: Record<string, unknown>;
  budget: BudgetAmount;
}): BudgetReachedFrame[] {
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
      budget: { amount_minor: input.budget.amount, currency: input.budget.currency },
    },
    { type: "session.status_idle", stop_reason: stop },
  ];
}
