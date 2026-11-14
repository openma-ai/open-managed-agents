// Session list-cost budget (official `budget.max_list_cost`).
//
// Layers:
//   domain  — SessionBudgetGate, `list_cost_pico`, ListCostPicoStore,
//             and the ONE model-egress meter (beginModelEgress /
//             completeModelEgress → recordModelEgress)
//   adapter — CF / Node: ListCostPicoStore + HTTP transport only
//   surface — Pi models proxy and sandbox inference-proxy both call the
//             same domain meter; no parallel budget helpers
//
// ACTIVE only when max_list_cost AND model-card pricing both exist.

const PICO_PER_CENT = 10_000_000_000n;
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
 * Dependency-inverted persist/load for the domain property `list_cost_pico`.
 * CF and Node implement this; they never invent a second field name.
 */
export interface ListCostPicoStore {
  /** Persisted `list_cost_pico`, or null when never written. */
  load(): string | null;
  /** Persist `list_cost_pico` (picodollars as an integer string). */
  save(list_cost_pico: string): void;
}

/** In-memory store for tests / ephemeral runs. */
export function memoryListCostPicoStore(initial: string | null = null): ListCostPicoStore {
  let value = initial;
  return {
    load: () => value,
    save: (list_cost_pico) => {
      value = list_cost_pico;
    },
  };
}

/**
 * Session-scoped egress meter + budget gate. Parent and subagents share ONE
 * instance. Null when inactive. `list_cost_pico` is the only counter name.
 */
export interface SessionBudgetGate {
  maxListCost: BudgetAmount;
  pricing: ListPricing;
  /** Exact consumed list cost in picodollars (integer string). */
  list_cost_pico: string;
  /** Set when completed usage reaches the cap or egress refuses a call. */
  reached: boolean;
  /** Ephemeral stop signal: this gate actually refused a model request. */
  refused?: boolean;
}

export function createSessionBudgetGate(
  budget: BudgetAmount | null | undefined,
  pricing: ListPricing | null | undefined,
  store: ListCostPicoStore,
): SessionBudgetGate | null {
  if (!budget || !pricing) return null;
  if (budget.currency !== "USD" || !/^(0|[1-9]\d*)$/.test(budget.amount)) return null;
  const loaded = store.load();
  const list_cost_pico = typeof loaded === "string" && /^\d+$/.test(loaded) ? loaded : "0";
  const gate: SessionBudgetGate = {
    maxListCost: { ...budget },
    pricing,
    list_cost_pico,
    reached: false,
  };
  GATE_STORES.set(gate, store);
  return gate;
}

const GATE_STORES = new WeakMap<SessionBudgetGate, ListCostPicoStore>();

/** A turn observes its own stop while charging the same session counter/store. */
export function turnSessionBudgetGate(gate: SessionBudgetGate): SessionBudgetGate {
  let reached = false;
  let refused = false;
  const turn: SessionBudgetGate = {
    maxListCost: gate.maxListCost,
    pricing: gate.pricing,
    get list_cost_pico() { return gate.list_cost_pico; },
    set list_cost_pico(value) { gate.list_cost_pico = value; },
    get refused() { return refused; },
    set refused(value) { refused = value === true; if (value) gate.refused = true; },
    get reached() { return reached; },
    set reached(value) { reached = value; if (value) gate.reached = true; },
  };
  const store = GATE_STORES.get(gate);
  if (store !== undefined) GATE_STORES.set(turn, store);
  return turn;
}

function storeOf(gate: SessionBudgetGate): ListCostPicoStore | undefined {
  return GATE_STORES.get(gate);
}

export function gateExhausted(gate: SessionBudgetGate | null | undefined): boolean {
  if (!gate) return false;
  return BigInt(gate.list_cost_pico) >= centsToPico(gate.maxListCost.amount);
}

/** @deprecated Prefer gateExhausted; kept for older budget callers. */
export function budgetExhausted(
  gate: SessionBudgetGate | null | undefined,
  _events?: readonly unknown[],
): boolean {
  return gateExhausted(gate);
}

/** Record one completed model request at egress; persist via the store port. */
export function recordModelEgress(
  gate: SessionBudgetGate | null | undefined,
  usage: TokenUsage,
): void {
  if (!gate) return;
  const next = BigInt(gate.list_cost_pico) + requestListCostPico(usage, gate.pricing);
  gate.list_cost_pico = next.toString();
  storeOf(gate)?.save(gate.list_cost_pico);
}

/**
 * ONE model-egress meter for every surface (Pi runtime, sandbox inference-
 * proxy, tests). Adapters may wrap this synchronously or over HTTP; they
 * must not invent a second allow/record path.
 */
export interface ModelEgress {
  /** false = refuse the call (also sets `gate.reached`). Inactive gate → true. */
  begin(): boolean;
  /** Persist usage via recordModelEgress; sets `reached` when now at/over cap. */
  complete(usage: TokenUsage): void;
}

/** Refuse at the cap before a model call. true = may proceed. */
export function beginModelEgress(gate: SessionBudgetGate | null | undefined): boolean {
  if (!gate) return true;
  if (!gateExhausted(gate)) return true;
  gate.reached = true;
  gate.refused = true;
  return false;
}

/** After a completed model call: record usage and mark `reached` if at cap. */
export function completeModelEgress(
  gate: SessionBudgetGate | null | undefined,
  usage: TokenUsage,
): void {
  if (!gate) return;
  recordModelEgress(gate, usage);
  if (gateExhausted(gate)) gate.reached = true;
}

/** In-process meter over a SessionBudgetGate. null when budget inactive. */
export function modelEgress(gate: SessionBudgetGate | null | undefined): ModelEgress | null {
  if (!gate) return null;
  return {
    begin: () => beginModelEgress(gate),
    complete: (usage) => completeModelEgress(gate, usage),
  };
}

export class SessionBudgetReachedError extends Error {
  constructor() {
    super("session budget reached");
    this.name = "SessionBudgetReachedError";
  }
}
