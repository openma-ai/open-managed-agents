/**
 * Normalisation: strip what varies between runs (generated ids, timestamps,
 * durations, sequence numbers) and keep event types, order, payloads and
 * outputs. Ids the scenarios choose themselves (prefix "parity_") survive, so
 * tool_use -> tool_result links stay visible.
 */

export const ID = "<id>";
export const TIME = "<time>";
export const DURATION = "<duration>";
export const SEQ = "<seq>";
export const TOKEN_COUNT = "<token_count>";

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const TIME_KEY = /(?:^|_)(?:at|ts|time|timestamp)$|_at_ms$|^ts$/u;
const DURATION_KEY = /(?:^|_)(?:seconds|duration|duration_ms|latency_ms|elapsed_ms)$|^duration/u;
// Token accounting depends on provider-side prompt serialization, cache state,
// and tokenizer/runtime details, so counts are not a stable cross-runtime
// parity boundary. Keep the fields present while normalizing their values.
const TOKEN_COUNT_KEY = /(?:^|_)(?:input|output)_tokens$/u;
const ID_KEY = /^(?:id|.*_id|.*_ids|.*_key)$/u;
const KEEP_ID = /^parity_/u;
const SEQ_KEY = /^(?:seq|sequence)$/u;

export interface NormalizeContext {
  /** Concrete ids this run created, replaced wherever they appear. */
  knownIds: Map<string, string>;
  /** Strip `name~run` suffixes. */
  runSuffix: string;
}

function replaceKnown(value: string, context: NormalizeContext): string {
  let out = value;
  for (const [concrete, placeholder] of context.knownIds) {
    if (concrete.length > 0 && out.includes(concrete)) out = out.split(concrete).join(placeholder);
  }
  if (context.runSuffix && out.includes(context.runSuffix)) out = out.split(context.runSuffix).join("");
  return out;
}

function normalizeIdValue(value: unknown, context: NormalizeContext): unknown {
  if (typeof value === "string") {
    if (KEEP_ID.test(value)) return value;
    const known = context.knownIds.get(value);
    return known ?? ID;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeIdValue(item, context));
  return normalizeValue(value, context);
}

export function normalizeValue(value: unknown, context: NormalizeContext, key?: string): unknown {
  if (key !== undefined) {
    if (SEQ_KEY.test(key) && typeof value === "number") return SEQ;
    if (TIME_KEY.test(key) && (typeof value === "number" || typeof value === "string")) return TIME;
    if (DURATION_KEY.test(key) && typeof value === "number") return DURATION;
    if (TOKEN_COUNT_KEY.test(key) && typeof value === "number") return TOKEN_COUNT;
    if (ID_KEY.test(key) && (typeof value === "string" || Array.isArray(value))) {
      return normalizeIdValue(value, context);
    }
  }
  if (typeof value === "string") {
    if (ISO_TIME.test(value)) return TIME;
    return replaceKnown(value, context);
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, context));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const childKey of Object.keys(value).sort()) {
      out[childKey] = normalizeValue((value as Record<string, unknown>)[childKey], context, childKey);
    }
    return out;
  }
  return value;
}

/** Event types that are pure timing signals and carry no payload. */
export const TIMING_ONLY_EVENT_TYPES = new Set(["span.model_first_token"]);

/**
 * Event types whose payload is retained below but whose stream slot is not a
 * stable cross-host ordering boundary. Usage rows can be appended by the
 * model telemetry path concurrently with thread lifecycle rows; keeping them
 * in `events.session.usage` preserves the evidence without making parity
 * depend on that storage scheduling detail.
 */
export const UNORDERED_EVENT_TYPES = new Set([
  "session.usage",
  "agent.tool_result",
  "session.thread_status_idle",
]);

export interface ParityObservation {
  /** Ordered public event types, timing-only and unordered telemetry removed. */
  event_types: string[];
  /** Normalised events grouped by type, in stream order within each type. */
  events: Record<string, unknown[]>;
  /** Selected public fields of GET /v1/sessions/:id. */
  session: Record<string, unknown>;
  /** Scenario-specific public reads (outputs, memories, statuses). */
  reads: Record<string, unknown>;
  /** Model calls per scripted agent (did the platform reach each model). */
  models: Record<string, unknown>;
  /** Waits that never saw their condition (recorded, never thrown). */
  timeouts: string[];
}

export const SESSION_FIELDS = [
  "budget",
  "outcome_evaluations",
  "resources",
  "stats",
  "status",
  "usage",
] as const;

/**
 * Events a scenario sent in ONE request have no defined order relative to
 * each other: platforms stamp their processed_at at different moments (Node
 * stamps user.message when its turn starts, user.define_outcome on accept),
 * so the listed order inside such a batch varies from run to run. The first
 * occurrence of each batched type keeps its stream slot; the slots are then
 * filled in type order. Events outside declared batches keep stream order.
 */
export function canonicalBatchOrder(events: Array<Record<string, unknown>>, batches: string[][]): Array<Record<string, unknown>> {
  const out = [...events];
  for (const batch of batches) {
    const slots: number[] = [];
    for (const type of new Set(batch)) {
      const index = out.findIndex((event) => event.type === type);
      if (index >= 0) slots.push(index);
    }
    slots.sort((a, b) => a - b);
    const picked = slots.map((slot) => out[slot]!).sort((a, b) => String(a.type).localeCompare(String(b.type)));
    slots.forEach((slot, index) => {
      out[slot] = picked[index]!;
    });
  }
  return out;
}

export function buildObservation(input: {
  events: Array<Record<string, unknown>>;
  session: Record<string, unknown> | null;
  reads: Record<string, unknown>;
  models: Record<string, unknown>;
  timeouts: string[];
  context: NormalizeContext;
  /** Event types sent together in one request (see canonicalBatchOrder). */
  batches?: string[][];
}): ParityObservation {
  const retained = input.events.filter((event) => !TIMING_ONLY_EVENT_TYPES.has(String(event.type)));
  const kept = canonicalBatchOrder(
    retained.filter((event) => !UNORDERED_EVENT_TYPES.has(String(event.type))),
    input.batches ?? [],
  );
  const events: Record<string, unknown[]> = {};
  for (const event of retained) {
    const type = String(event.type);
    (events[type] ??= []).push(normalizeValue(event, input.context));
  }
  const sortedEvents: Record<string, unknown[]> = {};
  for (const type of Object.keys(events).sort()) sortedEvents[type] = events[type]!;
  const session: Record<string, unknown> = {};
  for (const field of SESSION_FIELDS) {
    session[field] = input.session === null
      ? "<missing session>"
      : normalizeValue(field in input.session ? input.session[field] : "<absent>", input.context, field);
  }
  return {
    event_types: kept.map((event) => String(event.type)),
    events: sortedEvents,
    session,
    reads: normalizeValue(input.reads, input.context) as Record<string, unknown>,
    models: input.models,
    timeouts: [...input.timeouts],
  };
}

/** Golden file text: stable key order, trailing newline. */
export function serializeObservation(observation: ParityObservation): string {
  return `${JSON.stringify(observation, null, 2)}\n`;
}
