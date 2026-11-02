// Pi surface over the ONE domain model-egress meter.
// Domain owns SessionBudgetGate, `list_cost_pico`, ListCostPicoStore, and
// beginModelEgress / completeModelEgress. This module re-exports that API and
// wraps Pi `models` so every request hits the same meter as the sandbox
// inference-proxy (withHostedInferenceBudget).
import type { ModelPricing, SessionEvent } from "@open-managed-agents/api-types";
import {
  type BudgetAmount,
  type ListCostPicoStore,
  type ListPricing,
  type SessionBudgetGate,
  type TokenUsage,
  SessionBudgetReachedError,
  beginModelEgress,
  budgetExhausted,
  budgetReachedEvents as domainBudgetReachedEvents,
  centsToPico,
  completeModelEgress,
  createSessionBudgetGate as domainCreateSessionBudgetGate,
  gateExhausted,
  memoryListCostPicoStore,
  modelEgress,
  parseUsdPrice,
  picoToCentsString,
  recordModelEgress,
  requestListCostPico,
  runtimeListCost,
} from "@open-managed-agents/domain/sessions";

export {
  SessionBudgetReachedError,
  beginModelEgress,
  budgetExhausted,
  centsToPico,
  completeModelEgress,
  gateExhausted,
  memoryListCostPicoStore,
  modelEgress,
  parseUsdPrice,
  picoToCentsString,
  recordModelEgress,
  requestListCostPico,
  runtimeListCost,
};
export type { BudgetAmount, ListCostPicoStore, ListPricing, SessionBudgetGate, TokenUsage };

export function createSessionBudgetGate(
  budget: BudgetAmount | null | undefined,
  pricing: ModelPricing | ListPricing | null | undefined,
  store: ListCostPicoStore,
): SessionBudgetGate | null {
  return domainCreateSessionBudgetGate(budget, pricing as ListPricing | null | undefined, store);
}

export function budgetReachedEvents(input: {
  sessionThreadId?: string | null;
  usage: Record<string, unknown>;
  budget: BudgetAmount;
}): SessionEvent[] {
  return domainBudgetReachedEvents(input) as unknown as SessionEvent[];
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

/** Pi model egress: every request goes through domain begin/completeModelEgress. */
export function meterPiRuntime<T extends { models: object }>(
  pi: T,
  gate: SessionBudgetGate | null | undefined,
): T {
  if (!gate) return pi;
  const cached = METERED.get(pi.models);
  if (cached !== undefined && cached.gate === gate) return { ...pi, models: cached.models };
  const target = pi.models;
  const models = new Proxy(target, {
    get(obj, prop, receiver) {
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (STREAMING.has(prop)) {
        return (...args: unknown[]) => {
          if (!beginModelEgress(gate)) {
            const options = (args[2] ?? {}) as Record<string, unknown>;
            args[2] = { ...options, signal: AbortSignal.abort() };
          }
          const stream = fn.apply(obj, args) as { result?: () => Promise<PiResultLike> };
          void stream.result?.().then((message) => {
            const usage = piUsage(message);
            if (usage) completeModelEgress(gate, usage);
          }, () => undefined);
          return stream;
        };
      }
      if (COMPLETING.has(prop)) {
        return async (...args: unknown[]) => {
          if (!beginModelEgress(gate)) {
            throw new SessionBudgetReachedError();
          }
          const message = await (fn.apply(obj, args) as Promise<PiResultLike>);
          const usage = piUsage(message);
          if (usage) completeModelEgress(gate, usage);
          return message;
        };
      }
      return fn.bind(obj);
    },
  });
  METERED.set(target, { gate, models });
  return { ...pi, models };
}
