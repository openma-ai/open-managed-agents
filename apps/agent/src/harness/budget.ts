// Session list-cost budget (official `budget.max_list_cost`).
//
// The budget is ACTIVE only when the session has a `max_list_cost` AND the
// session's model card has `pricing`. Either one missing = no enforcement, no
// error.
//
// Bookkeeping lives at MODEL EGRESS: the gate is a session-scoped meter that
// every real model request (parent and subagent threads, loop and compaction)
// passes through via `meterPiRuntime`. It refuses requests at the cap and
// adds each completed request's list cost. The running total is seeded from
// the session's persisted counter (`usage.listCostPico`), never rebuilt from
// thread history.
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
 * Session-scoped egress meter + budget gate handed to every harness of the
 * session (parent and subagents share ONE instance). Null when inactive (no
 * budget, or no pricing on the model card).
 */
export interface SessionBudgetGate {
  maxListCost: BudgetAmount;
  pricing: ModelPricing;
  /** Exact consumed list cost (picodollars), maintained only at egress. */
  consumedPico: bigint;
  /** Persist hook, called after each recorded egress with the new total. */
  onEgress?: (consumedPico: bigint) => void;
  /** Set when egress refused a model call at the cap. */
  reached: boolean;
}

export function createSessionBudgetGate(
  budget: BudgetAmount | null | undefined,
  pricing: ModelPricing | null | undefined,
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

/** Pre-request check at egress: true once consumed list cost reached the cap.
 * The request that crosses the cap is allowed to finish; the NEXT one stops. */
export function gateExhausted(gate: SessionBudgetGate | null | undefined): boolean {
  if (!gate) return false;
  return gate.consumedPico >= centsToPico(gate.maxListCost.amount);
}

/** @deprecated default-loop only; same egress meter, no history. */
export function budgetExhausted(
  gate: SessionBudgetGate | null | undefined,
  _events?: readonly SessionEvent[],
): boolean {
  return gateExhausted(gate);
}

/** Record one completed model request at egress. */
export function recordModelEgress(gate: SessionBudgetGate | null | undefined, usage: TokenUsage): void {
  if (!gate) return;
  gate.consumedPico += requestListCostPico(usage, gate.pricing);
  gate.onEgress?.(gate.consumedPico);
}

/** Thrown by a metered non-streaming call refused at the cap. */
export class SessionBudgetReachedError extends Error {
  constructor() {
    super("session budget reached");
    this.name = "SessionBudgetReachedError";
  }
}

interface PiUsageLike { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
interface PiResultLike { usage?: PiUsageLike }

function piUsage(message: PiResultLike | undefined): TokenUsage | null {
  const u = message?.usage;
  if (!u) return null;
  return {
    input_tokens: u.input,
    output_tokens: u.output,
    cache_read_input_tokens: u.cacheRead,
    cache_creation_input_tokens: u.cacheWrite,
  };
}

const METERED = new WeakMap<object, { gate: SessionBudgetGate; models: object }>();
const STREAMING = new Set(["stream", "streamSimple"]);
const COMPLETING = new Set(["complete", "completeSimple"]);

/**
 * Model egress: wrap a Pi runtime's `models` so EVERY request is gated and
 * metered against the session gate. Streams refused at the cap are issued
 * with an already-aborted signal (no tokens spent); non-streaming calls
 * throw `SessionBudgetReachedError`. Idempotent per (models, gate).
 */
export function meterPiRuntime<T extends { models: object }>(pi: T, gate: SessionBudgetGate | null | undefined): T {
  if (!gate) return pi;
  const cached = METERED.get(pi.models);
  if (cached?.gate === gate) return { ...pi, models: cached.models };
  const target = pi.models;
  const models = new Proxy(target, {
    get(obj, prop, receiver) {
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (STREAMING.has(prop)) {
        return (...args: unknown[]) => {
          if (gateExhausted(gate)) {
            gate.reached = true;
            const options = (args[2] ?? {}) as Record<string, unknown>;
            args[2] = { ...options, signal: AbortSignal.abort() };
          }
          const stream = fn.apply(obj, args) as { result?: () => Promise<PiResultLike> };
          void stream.result?.().then((message) => {
            const usage = piUsage(message);
            if (usage) recordModelEgress(gate, usage);
          }, () => undefined);
          return stream;
        };
      }
      if (COMPLETING.has(prop)) {
        return async (...args: unknown[]) => {
          if (gateExhausted(gate)) {
            gate.reached = true;
            throw new SessionBudgetReachedError();
          }
          const message = await (fn.apply(obj, args) as Promise<PiResultLike>);
          const usage = piUsage(message);
          if (usage) recordModelEgress(gate, usage);
          return message;
        };
      }
      return fn.bind(obj);
    },
  });
  METERED.set(target, { gate, models });
  return { ...pi, models };
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


