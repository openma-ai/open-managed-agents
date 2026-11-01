// Harness adapter over the domain session budget gate.
//
// Domain (`@open-managed-agents/domain/sessions`) owns SessionBudgetGate,
// list_cost math, and the budget_reached stop sequence. This module re-exports
// that API and adds the Pi-only model egress wrapper (`meterPiRuntime`) so
// every real model request (parent + subagent, loop + compaction) is gated
// and metered. CF SessionDO and the Node runner only create/persist the gate.
import type { ModelPricing } from "@open-managed-agents/api-types";
import type { SessionEvent } from "@open-managed-agents/api-types";
import {
  type BudgetAmount,
  type BudgetReachedFrame,
  type ListPricing,
  type SessionBudgetGate,
  type TokenUsage,
  SessionBudgetReachedError,
  budgetExhausted,
  budgetReachedEvents as domainBudgetReachedEvents,
  centsToPico,
  createSessionBudgetGate as domainCreateSessionBudgetGate,
  gateExhausted,
  parseUsdPrice,
  picoToCentsString,
  recordModelEgress,
  requestListCostPico,
  runtimeListCost,
} from "@open-managed-agents/domain/sessions";

export {
  SessionBudgetReachedError,
  budgetExhausted,
  centsToPico,
  gateExhausted,
  parseUsdPrice,
  picoToCentsString,
  recordModelEgress,
  requestListCostPico,
  runtimeListCost,
};
export type { BudgetAmount, ListPricing, SessionBudgetGate, TokenUsage };

/** ModelPricing (api-types) is the same shape as domain ListPricing. */
export function createSessionBudgetGate(
  budget: BudgetAmount | null | undefined,
  pricing: ModelPricing | ListPricing | null | undefined,
  seed: { consumedPico?: string | bigint | null; onEgress?: (consumedPico: bigint) => void } = {},
): SessionBudgetGate | null {
  return domainCreateSessionBudgetGate(budget, pricing as ListPricing | null | undefined, seed);
}

/** Wire SessionEvent frames for the stop sequence (caller stamps ids/ts). */
export function budgetReachedEvents(input: {
  sessionThreadId?: string | null;
  usage: Record<string, unknown>;
  budget: BudgetAmount;
}): SessionEvent[] {
  return domainBudgetReachedEvents(input) as unknown as SessionEvent[];
}

export type { BudgetReachedFrame };

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
 * Pi model egress: wrap `pi.models` so every request is gated and metered
 * against the domain SessionBudgetGate. Idempotent per (models, gate).
 */
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

/** @deprecated History rebuild; prefer gate.consumedPico. Kept for callers mid-migration. */
export function consumedListCostPico(
  events: readonly SessionEvent[],
  pricing: ModelPricing,
): bigint {
  let total = 0n;
  for (const event of events) {
    if (event.type !== "span.model_request_end") continue;
    const usage = (event as { model_usage?: TokenUsage }).model_usage;
    if (usage) total += requestListCostPico(usage, pricing as ListPricing);
  }
  return total;
}
