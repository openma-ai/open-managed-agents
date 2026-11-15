// Official session budget rules (Managed Agents § Session budgets) and the
// ONE session usage / budget implementation shared by Cloudflare (SessionDO)
// and Node (managed runner). Design §0.7 "用量 / 预算".
//
// Enforcement itself is a runtime pre-request gate and is ACTIVE only when the
// session has `budget.max_list_cost` AND its model card has pricing. The
// domain owns the gate and the model-egress meter (begin/completeModelEgress);
// this module owns the use cases around them: token accounting, the usage
// snapshot, opening the gate for an execution, the budget_reached stop events
// and the /model-egress transport protocol. Platforms only inject storage
// (SessionUsageStorePort, ListCostPicoStore) and model-card lookup.
import type { MonetaryAmount, Session, SessionUsage } from "../domain/session";
import {
  beginModelEgress,
  completeModelEgress,
  createSessionBudgetGate,
  picoToCentsString,
  type ListCostPicoStore,
  type ListPricing,
  type SessionBudgetGate,
  type TokenUsage,
} from "@open-managed-agents/domain/sessions";

export const BUDGET_SETTLE_EVENT_TYPES = [
  "user.tool_confirmation",
  "user.tool_result",
  "user.custom_tool_result",
  "user.interrupt",
] as const;

export const BUDGET_NOT_GREATER_THAN_CONSUMED =
  "budget.max_list_cost must be greater than the session's consumed list cost";

export const BUDGET_CREATE_ONLY =
  "budget can only be set when the session is created; it can be changed or removed (budget: null) but not added";

const PICO_PER_CENT = 10_000_000_000n;

/** Exact consumed list cost in picodollars from the session's latest usage
 * snapshot (falls back to the rounded cents when no exact value exists). */
export function consumedListCostPico(session: Pick<Session, "usage">): bigint {
  const exact = session.usage?.list_cost_pico;
  if (typeof exact === "string" && /^\d+$/.test(exact)) return BigInt(exact);
  const amount = session.usage?.listCost?.amountMinor;
  return amount !== undefined && /^\d+$/.test(amount) ? BigInt(amount) * PICO_PER_CENT : 0n;
}

/**
 * Validate a `budget` update. Returns an error message or null.
 * - Adding a budget to a session created without one (or whose budget was
 *   removed — removal is one-way) is rejected.
 * - A changed cap must be strictly greater than the consumed list cost.
 * - `null` removes the budget.
 */
export function validateBudgetUpdate(
  current: Session,
  next: MonetaryAmount | null | undefined,
): string | null {
  if (next === undefined || next === null) return null;
  if (current.budget === null || current.budget === undefined) return BUDGET_CREATE_ONLY;
  if (BigInt(next.amountMinor) * PICO_PER_CENT <= consumedListCostPico(current)) {
    return BUDGET_NOT_GREATER_THAN_CONSUMED;
  }
  return null;
}

/** True when the session has a budget at or below its consumed list cost. */
export function sessionBudgetExhausted(session: Pick<Session, "budget" | "usage">): boolean {
  if (session.budget === null || session.budget === undefined) return false;
  return BigInt(session.budget.amountMinor) * PICO_PER_CENT <= consumedListCostPico(session);
}

/**
 * True while the session is paused at its cap: its latest idle stopped with
 * `budget_reached` and the current budget is still at or below the consumed
 * cost. Raising the cap above the consumed cost or removing it lifts the pause.
 */
export function sessionPausedAtBudget(
  session: Session,
  latestIdleStopReason: string | null,
): boolean {
  if (latestIdleStopReason !== "budget_reached") return false;
  if (session.status !== "idle") return false;
  return sessionBudgetExhausted(session);
}

export function budgetSettleOnlyMessage(): string {
  return `Session is paused at its budget (stop_reason budget_reached); only settle events are accepted: ${BUDGET_SETTLE_EVENT_TYPES.join(", ")}. Raise or remove the budget to continue.`;
}

// ─── Token accounting ──────────────────────────────────────────────────────

/** Token counters of one session thread (wire names, integer counts). */
export interface SessionTokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** Session-wide counters. Only input/output are kept session-wide; cache
 * buckets are per thread (their existing meaning on both platforms). */
export interface SessionWideTokenTotals {
  input_tokens: number;
  output_tokens: number;
}

export function emptySessionTokenTotals(): SessionTokenTotals {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

/** Pure add. Missing / NaN / 0 deltas add nothing (`|| 0`). */
export function addSessionTokenUsage(totals: SessionTokenTotals, delta: TokenUsage): SessionTokenTotals {
  return {
    input_tokens: totals.input_tokens + (delta.input_tokens || 0),
    output_tokens: totals.output_tokens + (delta.output_tokens || 0),
    cache_read_input_tokens: totals.cache_read_input_tokens + (delta.cache_read_input_tokens || 0),
    cache_creation_input_tokens: totals.cache_creation_input_tokens + (delta.cache_creation_input_tokens || 0),
  };
}

/** Any event; only `span.model_request_end` with `model_usage` is read. */
export interface ModelSpanLike { type?: string; model_usage?: Record<string, number | undefined> | null }

/**
 * Cache buckets carried by a `span.model_request_end`. Input/output arrive via
 * the harness `reportUsage`, so only the cache deltas are taken from the span.
 * Null when the event is not a model span or carries no cache tokens.
 */
export function cacheTokenUsageFromModelSpan(event: ModelSpanLike): TokenUsage | null {
  if (event.type !== "span.model_request_end") return null;
  const usage = event.model_usage;
  if (!usage) return null;
  const cache_creation_input_tokens = usage.cache_creation_input_tokens || 0;
  const cache_read_input_tokens = usage.cache_read_input_tokens || 0;
  if (cache_creation_input_tokens === 0 && cache_read_input_tokens === 0) return null;
  return { cache_creation_input_tokens, cache_read_input_tokens };
}

/** Totals of every `span.model_request_end.model_usage` in an event log. */
export function sumModelSpanUsage(events: readonly ModelSpanLike[]): SessionTokenTotals {
  let totals = emptySessionTokenTotals();
  for (const event of events) {
    if (event.type !== "span.model_request_end" || !event.model_usage) continue;
    totals = addSessionTokenUsage(totals, event.model_usage);
  }
  return totals;
}

/** Seed totals from a persisted Session.usage (5-minute cache bucket only;
 * it is the only one any runtime writes). */
export function sessionTokenTotalsFromUsage(usage: SessionUsage | null | undefined): SessionTokenTotals {
  return {
    input_tokens: usage?.inputTokens || 0,
    output_tokens: usage?.outputTokens || 0,
    cache_read_input_tokens: usage?.cacheReadInputTokens || 0,
    cache_creation_input_tokens: usage?.cacheCreation?.ephemeralFiveMinuteInputTokens || 0,
  };
}

/** Snake-case token usage; zero cache buckets are omitted. */
export function tokenTotalsToApiUsage(totals: SessionTokenTotals): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
} {
  return {
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    ...(totals.cache_read_input_tokens > 0 && { cache_read_input_tokens: totals.cache_read_input_tokens }),
    ...(totals.cache_creation_input_tokens > 0 && { cache_creation_input_tokens: totals.cache_creation_input_tokens }),
  };
}

/**
 * The ONE Session.usage snapshot. `listCost` (whole cents) and the exact
 * `list_cost_pico` are present only while a budget gate is active; their
 * value is the session egress meter's total (all threads).
 */
export function sessionUsageSnapshot(
  totals: SessionTokenTotals,
  gate: SessionBudgetGate | null | undefined,
): SessionUsage {
  const usage: SessionUsage = {
    inputTokens: totals.input_tokens,
    outputTokens: totals.output_tokens,
    ...(totals.cache_read_input_tokens > 0 && { cacheReadInputTokens: totals.cache_read_input_tokens }),
    ...(totals.cache_creation_input_tokens > 0 && {
      cacheCreation: { ephemeralFiveMinuteInputTokens: totals.cache_creation_input_tokens },
    }),
  };
  if (!gate) return usage;
  return {
    ...usage,
    listCost: { amountMinor: picoToCentsString(BigInt(gate.list_cost_pico)), currency: "USD" },
    list_cost_pico: gate.list_cost_pico,
  };
}

/**
 * Platform persistence for token counters. Cloudflare keeps them in SessionDO
 * state; Node keeps an execution-scoped in-memory store seeded from the
 * persisted Session.usage. Loads return null for a thread never credited.
 */
export interface SessionUsageStorePort {
  loadThread(threadId: string): SessionTokenTotals | null;
  loadSession(): SessionWideTokenTotals;
  save(change: { threadId: string; thread: SessionTokenTotals; session: SessionWideTokenTotals }): void;
}

export interface SessionUsageMeter {
  /** Credit a delta to a thread and keep the session-wide input/output in step. */
  credit(threadId: string, delta: TokenUsage): void;
  /** Credit the cache buckets of a model span. True when anything was credited. */
  creditModelSpan(threadId: string, event: ModelSpanLike): boolean;
  thread(threadId: string): SessionTokenTotals;
  session(): SessionWideTokenTotals;
}

export function createSessionUsageMeter(store: SessionUsageStorePort): SessionUsageMeter {
  const meter: SessionUsageMeter = {
    credit(threadId, delta) {
      const thread = addSessionTokenUsage(store.loadThread(threadId) ?? emptySessionTokenTotals(), delta);
      const session = store.loadSession();
      store.save({
        threadId,
        thread,
        session: {
          input_tokens: session.input_tokens + (delta.input_tokens || 0),
          output_tokens: session.output_tokens + (delta.output_tokens || 0),
        },
      });
    },
    creditModelSpan(threadId, event) {
      const cache = cacheTokenUsageFromModelSpan(event);
      if (cache === null) return false;
      meter.credit(threadId, cache);
      return true;
    },
    thread: (threadId) => ({ ...(store.loadThread(threadId) ?? emptySessionTokenTotals()) }),
    session: () => ({ ...store.loadSession() }),
  };
  return meter;
}

/** `session.usage` as published after a credit (BetaManagedAgentsSessionUsageEvent:
 * "Periodic snapshot of the session's cumulative usage"). Session.usage is
 * projected from it, so publishing it is what fills GET /v1/sessions/:id. */
export interface SessionUsageReport {
  type: "session.usage";
  usage: SessionUsage;
}

function usageReport(meter: SessionUsageMeter, threadId: string, gate: SessionBudgetGate | null | undefined): SessionUsageReport {
  return { type: "session.usage", usage: sessionUsageSnapshot(meter.thread(threadId), gate) };
}

/**
 * Credit one harness usage report (`reportUsage`: a turn's input/output
 * tokens) to a thread and return the `session.usage` event every platform
 * publishes right after it: the thread's cumulative totals, plus the list
 * cost while a budget gate is active.
 */
export function reportSessionUsage(
  meter: SessionUsageMeter,
  threadId: string,
  delta: TokenUsage,
  gate: SessionBudgetGate | null | undefined,
): SessionUsageReport {
  meter.credit(threadId, delta);
  return usageReport(meter, threadId, gate);
}

/** Credit the cache buckets of a model span; the `session.usage` event to
 * publish when anything was credited, else null. */
export function reportModelSpanUsage(
  meter: SessionUsageMeter,
  threadId: string,
  event: ModelSpanLike,
  gate: SessionBudgetGate | null | undefined,
): SessionUsageReport | null {
  return meter.creditModelSpan(threadId, event) ? usageReport(meter, threadId, gate) : null;
}

/** In-memory store (Node execution runtime, tests). */
export function memorySessionUsageStore(
  seed: { threads?: Record<string, SessionTokenTotals>; session?: SessionWideTokenTotals } = {},
): SessionUsageStorePort {
  const threads = new Map(Object.entries(seed.threads ?? {}).map(([id, totals]) => [id, { ...totals }]));
  let session: SessionWideTokenTotals = { input_tokens: 0, output_tokens: 0, ...seed.session };
  return {
    loadThread: (threadId) => {
      const totals = threads.get(threadId);
      return totals === undefined ? null : { ...totals };
    },
    loadSession: () => ({ ...session }),
    save: (change) => {
      threads.set(change.threadId, { ...change.thread });
      session = { ...change.session };
    },
  };
}

// ─── Budget gate for one execution ─────────────────────────────────────────

interface PricedModelCard {
  archived_at?: string | number | null;
  pricing?: ListPricing | null;
}

/** List pricing of a model card that may meter a budget: archived cards and
 * unpriced cards meter nothing. */
export function activeModelCardPricing(card: PricedModelCard | null | undefined): ListPricing | null {
  return card && !card.archived_at ? card.pricing ?? null : null;
}

export interface OpenSessionBudgetGateInput {
  session: Pick<Session, "budget" | "usage">;
  /** Looked up only when the session has a budget. */
  pricing(): Promise<ListPricing | null>;
  /** Platform persistence of `list_cost_pico`. */
  store: ListCostPicoStore;
}

/**
 * Open the session egress meter for one execution. Null (inactive) unless the
 * session has a budget AND its model card is priced. The consumed cost
 * resumes from the platform store; when that holds no exact value it resumes
 * from the Session's persisted usage (exact picodollars, else rounded cents)
 * rather than from 0.
 */
export async function openSessionBudgetGate(
  input: OpenSessionBudgetGateInput,
): Promise<SessionBudgetGate | null> {
  const budget = input.session.budget ?? null;
  if (budget === null) return null;
  const pricing = await input.pricing();
  if (pricing === null) return null;
  const persisted = consumedListCostPico(input.session as Session).toString();
  return createSessionBudgetGate(
    { amount: budget.amountMinor, currency: budget.currency },
    pricing,
    {
      load: () => {
        const stored = input.store.load();
        return typeof stored === "string" && /^\d+$/.test(stored) ? stored : persisted;
      },
      save: (listCostPico) => input.store.save(listCostPico),
    },
  );
}

type BudgetReachedStop = { type: "budget_reached" };

export type BudgetReachedStopEvents<Thread> = [
  { type: "session.thread_status_idle"; stopReason: BudgetReachedStop } & Thread,
  { type: "session.usage"; usage: SessionUsage; budget: MonetaryAmount },
  { type: "session.status_idle"; stopReason: BudgetReachedStop },
];

/**
 * The official budget stop (Managed Agents § Session budgets): thread idle,
 * then the usage snapshot with the budget, then session idle — all with
 * stop_reason budget_reached. Application events: Node publishes them as is,
 * Cloudflare encodes them onto its event log.
 */
export function budgetReachedStopEvents(input: {
  agentName: string;
  sessionThreadId: string;
  usage: SessionUsage;
  budget: { amount: string; currency: string };
}): BudgetReachedStopEvents<{ agentName: string; sessionThreadId: string }>;
export function budgetReachedStopEvents(input: {
  agentName?: string;
  sessionThreadId?: string | null;
  usage: SessionUsage;
  budget: { amount: string; currency: string };
}): BudgetReachedStopEvents<{ agentName?: string; sessionThreadId?: string }>;
export function budgetReachedStopEvents(input: {
  agentName?: string;
  sessionThreadId?: string | null;
  usage: SessionUsage;
  budget: { amount: string; currency: string };
}): BudgetReachedStopEvents<{ agentName?: string; sessionThreadId?: string }> {
  return [
    {
      type: "session.thread_status_idle",
      ...(input.agentName !== undefined && { agentName: input.agentName }),
      ...(input.sessionThreadId ? { sessionThreadId: input.sessionThreadId } : {}),
      stopReason: { type: "budget_reached" },
    },
    {
      type: "session.usage",
      usage: input.usage,
      budget: { amountMinor: input.budget.amount, currency: input.budget.currency as MonetaryAmount["currency"] },
    },
    { type: "session.status_idle", stopReason: { type: "budget_reached" } },
  ];
}

// ─── /model-egress transport protocol ──────────────────────────────────────

export type ModelEgressRequest =
  | { action: "begin" }
  | { action: "complete"; usage: TokenUsage };

export function parseModelEgressRequest(body: unknown): ModelEgressRequest | null {
  if (body === null || typeof body !== "object") return null;
  const { action, usage } = body as { action?: unknown; usage?: unknown };
  if (action === "begin") return { action };
  if (action === "complete") {
    return { action, usage: usage !== null && typeof usage === "object" ? usage as TokenUsage : {} };
  }
  return null;
}

export const MODEL_EGRESS_ACTION_REQUIRED = "action required (begin|complete)";

/** Apply one remote egress action to the session meter (inactive → allow). */
export function applyModelEgressRequest(
  gate: SessionBudgetGate | null | undefined,
  request: ModelEgressRequest,
):
  | { active: false; allowed: true; list_cost_pico: null }
  | { active: true; allowed: boolean; reached: boolean; list_cost_pico: string }
  | { active: true; reached: boolean; list_cost_pico: string } {
  if (!gate) return { active: false, allowed: true, list_cost_pico: null };
  if (request.action === "begin") {
    const allowed = beginModelEgress(gate);
    return { active: true, allowed, reached: gate.reached, list_cost_pico: gate.list_cost_pico };
  }
  completeModelEgress(gate, request.usage);
  return { active: true, reached: gate.reached, list_cost_pico: gate.list_cost_pico };
}
