// Trace projection: raw event stream → turns, (agents), steps, gaps.
//
// Pure helpers behind the unified Trace view (components/timeline/
// TraceView). They accept both the trajectory envelope's `StoredEvent`
// rows (`{ seq, type, data: "<json>", ts }`) and already-unwrapped live
// session events, so the same projection serves
// `GET /v1/oma/sessions/:id/trajectory`, the live stream and fixtures.
//
// Semantics come from the original Timeline (components/timeline/derive):
//   - turn — user trigger (user.message / tool_confirmation /
//            custom_tool_result) through session.status_idle /
//            status_terminated / session.error. Tool results never open
//            a turn.
//   - step — one model call, tool call (paired with its result by call
//            id), schedule wait, message or lifecycle marker.
//   - agent — only when the stream really mixes session threads
//            (session_thread_id / session.thread_created). Never invented.
//   - gap  — the interval between two turns: "idle" only when the
//            previous turn closed (endedAt) and the next trigger is later;
//            "unknown" when a close event or timestamp is missing.

import type { Event } from "./events";
import { formatDuration, pickTickStep } from "./format";
import {
  bucketIntoTurns,
  deriveTraceSteps,
  eventText,
  eventTsOrNull,
  oneLine,
  summarizeToolInput,
} from "../components/timeline/derive";
import {
  COLLAPSED_GAP_FRACTION,
  MAX_CHART_PX,
  MAX_OVERVIEW_LANES,
  MAX_TICKS,
  TRIGGER_LABEL,
  type TraceStep,
  type Turn,
} from "../components/timeline/types";

export { eventText, oneLine, summarizeToolInput };

/** A session event after unwrapping, with its resolved wall-clock time. */
export interface TrajectoryEvent {
  /** Position in the source array; stable fallback id. */
  index: number;
  type: string;
  seq: number | null;
  /** Epoch milliseconds, or null when the event carries no usable time. */
  ts: number | null;
  /** The unwrapped session event. */
  raw: Record<string, unknown>;
}

// ─── Event normalization ─────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Resolve epoch ms from `occurred_at` / `ts` (ISO or unix seconds/ms). */
export function resolveEventTime(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) {
      return c < 1e12 ? c * 1000 : c;
    }
    if (typeof c === "string" && c) {
      const iso = Date.parse(c);
      if (Number.isFinite(iso)) return iso;
      const n = Number(c);
      if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
    }
  }
  return null;
}

/**
 * Normalize one entry of `trajectory.events` (or a live event). StoredEvent
 * rows carry the session event as a JSON string in `data`; anything else is
 * treated as an already-unwrapped event. Span events keep an object-valued
 * `data`, which is left alone. Returns null for entries without a type.
 */
export function normalizeEvent(input: unknown, index: number): TrajectoryEvent | null {
  if (!isRecord(input)) return null;
  let raw: Record<string, unknown> = input;
  if (typeof input.data === "string") {
    try {
      const parsed: unknown = JSON.parse(input.data);
      if (isRecord(parsed)) raw = { ...parsed, type: parsed.type ?? input.type };
    } catch {
      // Malformed payload: keep the envelope row so it still shows up.
    }
  }
  const type = typeof raw.type === "string" ? raw.type : typeof input.type === "string" ? input.type : "";
  if (!type) return null;
  const seqSource = input.seq ?? raw.seq;
  const data = isRecord(raw.data) ? raw.data : undefined;
  return {
    index,
    type,
    seq: typeof seqSource === "number" ? seqSource : null,
    ts: resolveEventTime(raw.occurred_at, data?.occurred_at, input.ts, raw.ts, raw.created_at),
    raw,
  };
}

export function normalizeEvents(input: readonly unknown[] | undefined | null): TrajectoryEvent[] {
  if (!Array.isArray(input)) return [];
  const out: TrajectoryEvent[] = [];
  input.forEach((e, i) => {
    const n = normalizeEvent(e, i);
    if (n) out.push(n);
  });
  return out;
}

const SHELL_TOOLS = new Set(["bash", "shell", "sh", "terminal", "exec", "run_command"]);

export function isShellTool(name: string | undefined): boolean {
  return !!name && SHELL_TOOLS.has(name.toLowerCase());
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/**
 * Unwrap envelope rows into flat session events. The resolved time is
 * written to `ts` only when the flat event has no usable time of its own
 * (StoredEvent rows keep it on the envelope row).
 */
export function flattenEvents(input: readonly unknown[] | undefined | null): Event[] {
  return normalizeEvents(input).map((n) => {
    const ev = { ...n.raw, type: n.type } as Event;
    if (n.ts !== null && eventTsOrNull(ev) === null) ev.ts = new Date(n.ts).toISOString();
    if (n.seq !== null && ev.seq === undefined) ev.seq = n.seq;
    return ev;
  });
}

// ─── Projection ──────────────────────────────────────────────────────

export const PRIMARY_THREAD = "sthr_primary";

export interface ThreadInfo {
  id: string;
  agentName?: string;
  parentThreadId?: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  /** Model calls that reported usage. */
  calls: number;
}

export interface TraceTurn {
  key: string;
  index: number;
  turn: Turn;
  steps: TraceStep[];
  /** Trigger time, else first timed event in the turn. */
  startTs: number | null;
  /** Close time (status_idle / terminated / error); null while open. */
  endTs: number | null;
  /** Last timed event in the turn. */
  lastTs: number | null;
  closed: boolean;
  /** closed: end − start; open: last event − start (still growing). */
  durationMs: number | null;
  /** null when no model call in the turn reported usage. */
  tokens: TokenTotals | null;
  errors: number;
  toolCalls: number;
  triggerText: string | null;
}

export type GapKind = "idle" | "unknown";

export interface TraceGap {
  key: string;
  /** Index of the turn before the gap. */
  afterTurn: number;
  kind: GapKind;
  startTs: number | null;
  endTs: number | null;
  durationMs: number | null;
  /** Next turn was fired by a scheduled wakeup. */
  scheduledWakeup: boolean;
  /** Evidence (idle) or what is missing (unknown). */
  reason: string;
}

export interface TraceProjection {
  events: Event[];
  steps: TraceStep[];
  turns: TraceTurn[];
  gaps: TraceGap[];
  threads: Map<string, ThreadInfo>;
  rootThread: string | null;
  /** True only when events carry more than one session_thread_id. */
  multiThread: boolean;
  startTs: number | null;
  endTs: number | null;
  models: string[];
  tokens: TokenTotals | null;
  /** Usage reported by span.compaction_summarize_end, kept apart from
   *  generation tokens (the span type exists so summarize cost is
   *  attributed separately). null when none was reported. */
  compactionTokens: TokenTotals | null;
  toolCalls: number;
  errors: number;
}

/** Generation usage only — compaction summarize usage is tallied apart. */
function addUsage(acc: TokenTotals | null, s: TraceStep): TokenTotals | null {
  if (!s.usage || s.kind !== "model") return acc;
  return addReported(acc, s);
}

function addReported(acc: TokenTotals | null, s: TraceStep): TokenTotals | null {
  if (!s.usage) return acc;
  const t = acc ?? { input: 0, output: 0, cacheRead: 0, calls: 0 };
  t.input += s.usage.input_tokens ?? 0;
  t.output += s.usage.output_tokens ?? 0;
  t.cacheRead += s.usage.cache_read_input_tokens ?? 0;
  t.calls += 1;
  return t;
}

function triggerTextOf(turn: Turn): string | null {
  if (!turn.trigger) return null;
  const text = eventText(turn.trigger as Record<string, unknown>);
  return text ? oneLine(text, 80) : null;
}

/**
 * Classify the interval between two consecutive turns. Mirrors the
 * original Timeline IdleDivider rule: idle only when the previous turn has
 * a close time AND the next trigger is later. Anything else with a
 * positive interval is "unknown", never idle.
 */
export function classifyGap(prev: TraceTurn, next: TraceTurn, hasTiming: boolean): TraceGap | null {
  const endedAt = prev.turn.endedAt && prev.turn.endedAt > 0 ? prev.turn.endedAt : null;
  const trig = next.turn.triggerTs > 0 ? next.turn.triggerTs : null;
  const base = { key: `gap-${prev.index}`, afterTurn: prev.index, scheduledWakeup: next.turn.triggerKind === "wakeup" };
  if (endedAt !== null && trig !== null) {
    if (trig <= endedAt) return null;
    const why = prev.turn.status === "completed" ? "session.status_idle" : prev.turn.status === "terminated" ? "session.status_terminated" : "session.error";
    return { ...base, kind: "idle", startTs: endedAt, endTs: trig, durationMs: trig - endedAt, reason: `Turn ${prev.index + 1} closed by ${why}; next trigger is later.` };
  }
  if (!hasTiming) return null;
  if (endedAt === null && prev.lastTs !== null && trig !== null) {
    if (trig <= prev.lastTs) return null;
    return {
      ...base, kind: "unknown", startTs: prev.lastTs, endTs: trig, durationMs: trig - prev.lastTs,
      reason: `Turn ${prev.index + 1} has no close event (status_idle / status_terminated / error), so this interval is not classified as idle.`,
    };
  }
  return {
    ...base, kind: "unknown", startTs: endedAt ?? prev.lastTs, endTs: trig, durationMs: null,
    reason: trig === null ? `Turn ${next.index + 1} trigger has no timestamp.` : `Turn ${prev.index + 1} has no timestamps.`,
  };
}

/** Project a raw event list (envelope rows or live events) into a trace. */
export function buildTrace(input: readonly unknown[] | undefined | null): TraceProjection {
  const events = flattenEvents(input);
  const threadOf = (e: Event) => str((e as Record<string, unknown>).session_thread_id) ?? PRIMARY_THREAD;
  const threadIds = new Set(events.map(threadOf));
  const multiThread = threadIds.size > 1;
  const rootThread = events.length === 0 ? null : multiThread && threadIds.has(PRIMARY_THREAD) ? PRIMARY_THREAD : threadOf(events[0]!);
  const rawTurns = bucketIntoTurns(events, multiThread ? (e) => threadOf(e) === rootThread : undefined);
  const turnOfEvent = new Map<Event, number>();
  rawTurns.forEach((t, ti) => t.events.forEach((e) => turnOfEvent.set(e, ti)));

  const threads = new Map<string, ThreadInfo>();
  for (const e of events) {
    if (e.type !== "session.thread_created") continue;
    const id = str((e as Record<string, unknown>).session_thread_id);
    if (!id) continue;
    threads.set(id, {
      id,
      agentName: str((e as Record<string, unknown>).agent_name),
      parentThreadId: str((e as Record<string, unknown>).parent_thread_id),
    });
  }

  const steps = deriveTraceSteps(events);
  const perTurn: TraceStep[][] = rawTurns.map(() => []);
  for (const s of steps) perTurn[turnOfEvent.get(s.events[0]!) ?? 0]?.push(s);

  let sessionTokens: TokenTotals | null = null;
  let compactionTokens: TokenTotals | null = null;
  const models = new Set<string>();
  const turns: TraceTurn[] = rawTurns.map((turn, index) => {
    const ts = turn.events.map(eventTsOrNull).filter((t): t is number => t !== null);
    const first = ts.length ? Math.min(...ts) : null;
    const lastTs = ts.length ? Math.max(...ts) : null;
    const startTs = turn.triggerTs > 0 ? turn.triggerTs : first;
    const endTs = turn.endedAt && turn.endedAt > 0 ? turn.endedAt : null;
    const closed = endTs !== null;
    const own = perTurn[index]!;
    let tokens: TokenTotals | null = null;
    for (const s of own) {
      tokens = addUsage(tokens, s);
      sessionTokens = addUsage(sessionTokens, s);
      if (s.family === "compaction") compactionTokens = addReported(compactionTokens, s);
      if (s.model && s.kind === "model") models.add(s.model);
    }
    return {
      key: turn.id,
      index,
      turn,
      steps: own,
      startTs,
      endTs,
      lastTs,
      closed,
      durationMs: startTs === null ? null : closed ? Math.max(0, endTs! - startTs) : lastTs !== null ? Math.max(0, lastTs - startTs) : null,
      tokens,
      errors: own.filter((s) => s.isError).length,
      toolCalls: own.filter((s) => s.kind === "tool" && !s.orphan).length,
      triggerText: triggerTextOf(turn),
    };
  });

  const timed = events.map(eventTsOrNull).filter((t): t is number => t !== null);
  const hasTiming = timed.length > 0;
  const gaps: TraceGap[] = [];
  for (let i = 1; i < turns.length; i++) {
    const g = classifyGap(turns[i - 1]!, turns[i]!, hasTiming);
    if (g) gaps.push(g);
  }

  return {
    events,
    steps,
    turns,
    gaps,
    threads,
    rootThread,
    multiThread,
    startTs: hasTiming ? Math.min(...timed) : null,
    endTs: hasTiming ? Math.max(...timed) : null,
    models: [...models],
    tokens: sessionTokens,
    compactionTokens,
    toolCalls: turns.reduce((n, t) => n + t.toolCalls, 0),
    errors: turns.reduce((n, t) => n + t.errors, 0),
  };
}

/** "5m0s idle · scheduled wakeup" / "2.00s unclassified" / "gap unknown". */
export function gapLabel(g: TraceGap): string {
  if (g.kind === "idle") return `${formatDuration(g.durationMs!)} idle${g.scheduledWakeup ? " · scheduled wakeup" : ""}`;
  return g.durationMs !== null ? `${formatDuration(g.durationMs)} unknown` : "gap unknown";
}

export function turnTriggerLabel(t: TraceTurn): string {
  return TRIGGER_LABEL[t.turn.triggerKind];
}

// ─── Tree ────────────────────────────────────────────────────────────

export interface TraceGroupNode {
  type: "group";
  key: string;
  toolName: string;
  steps: TraceStep[];
  startTs: number | null;
  endTs: number | null;
  durationMs: number | null;
  errors: number;
  order: number;
}

export interface TraceAgentNode {
  type: "agent";
  key: string;
  threadId: string;
  label: string;
  agentName?: string;
  parentThreadId?: string;
  children: TraceNode[];
  startTs: number | null;
  endTs: number | null;
  durationMs: number | null;
  errors: number;
  order: number;
}

export interface TraceStepNode {
  type: "step";
  key: string;
  step: TraceStep;
  order: number;
}

export type TraceNode = TraceStepNode | TraceGroupNode | TraceAgentNode;

export const MIN_GROUP_SIZE = 3;

function span(steps: readonly TraceStep[]): { startTs: number | null; endTs: number | null; durationMs: number | null } {
  const starts = steps.map((s) => s.startTs).filter((t): t is number => t !== null);
  const ends = steps.map((s) => s.endTs ?? s.startTs).filter((t): t is number => t !== null);
  const startTs = starts.length ? Math.min(...starts) : null;
  const endTs = ends.length ? Math.max(...ends) : null;
  return { startTs, endTs, durationMs: startTs !== null && endTs !== null ? endTs - startTs : null };
}

/** Fold runs of MIN_GROUP_SIZE+ consecutive same-tool, non-shell calls. */
export function groupSteps(steps: readonly TraceStep[]): Array<TraceStepNode | TraceGroupNode> {
  const out: Array<TraceStepNode | TraceGroupNode> = [];
  const foldable = (s: TraceStep) => s.kind === "tool" && !s.orphan && !isShellTool(s.toolName);
  let i = 0;
  while (i < steps.length) {
    const s = steps[i]!;
    let j = i + 1;
    if (foldable(s)) {
      while (j < steps.length && foldable(steps[j]!) && steps[j]!.toolName === s.toolName && steps[j]!.toolSource === s.toolSource) j++;
    }
    const run = steps.slice(i, j);
    if (foldable(s) && run.length >= MIN_GROUP_SIZE) {
      out.push({ type: "group", key: `group:${s.key}`, toolName: s.label, steps: run, ...span(run), errors: run.filter((r) => r.isError).length, order: s.order });
      i = j;
    } else {
      out.push({ type: "step", key: s.key, step: s, order: s.order });
      i += 1;
    }
  }
  return out;
}

export function isGroupNode(n: TraceNode): n is TraceGroupNode {
  return n.type === "group";
}

/**
 * Tree under one turn. Flat (steps / groups) unless the stream mixes
 * threads; then each non-root thread becomes an agent node, nested under
 * its parent thread's node when session.thread_created says so and that
 * parent also has steps in this turn. Root-thread steps stay directly
 * under the turn — no synthetic "root agent".
 */
export function buildTurnTree(
  turnKey: string,
  steps: readonly TraceStep[],
  p: Pick<TraceProjection, "threads" | "rootThread" | "multiThread">,
): TraceNode[] {
  if (!p.multiThread) return groupSteps(steps);
  const rootSteps: TraceStep[] = [];
  const byThread = new Map<string, TraceStep[]>();
  for (const s of steps) {
    const th = s.threadId ?? PRIMARY_THREAD;
    if (th === p.rootThread) rootSteps.push(s);
    else byThread.set(th, [...(byThread.get(th) ?? []), s]);
  }
  const agents = new Map<string, TraceAgentNode>();
  for (const [threadId, own] of byThread) {
    const info = p.threads.get(threadId);
    agents.set(threadId, {
      type: "agent",
      key: `${turnKey}:agent:${threadId}`,
      threadId,
      label: info?.agentName ?? threadId,
      agentName: info?.agentName,
      parentThreadId: info?.parentThreadId,
      children: groupSteps(own),
      ...span(own),
      errors: own.filter((s) => s.isError).length,
      order: own[0]!.order,
    });
  }
  const top: TraceNode[] = groupSteps(rootSteps);
  for (const a of agents.values()) {
    const parent = a.parentThreadId && a.parentThreadId !== p.rootThread ? agents.get(a.parentThreadId) : undefined;
    if (parent && parent !== a) parent.children.push(a);
    else top.push(a);
  }
  const sortRec = (nodes: TraceNode[]) => {
    nodes.sort((x, y) => x.order - y.order);
    for (const n of nodes) if (n.type === "agent") sortRec(n.children);
  };
  sortRec(top);
  return top;
}

/** Every step under a node, depth-first. */
export function nodeSteps(n: TraceNode): TraceStep[] {
  if (n.type === "step") return [n.step];
  if (n.type === "group") return n.steps;
  return n.children.flatMap(nodeSteps);
}

// ─── Filters ─────────────────────────────────────────────────────────

export type StepFilterKind = "user" | "assistant" | "thinking" | "model" | "tool" | "compaction" | "error";

export const STEP_FILTER_KINDS: StepFilterKind[] = ["user", "assistant", "thinking", "model", "tool", "compaction", "error"];

/** The Pi assembly adapter's post-compaction marker (a session.warning). */
export const CONTEXT_REASSEMBLED_SOURCE = "oma.context_reassembled";

/** Compaction family, or the session.warning that reports re-assembly after it. */
export function isCompactionRelated(step: TraceStep): boolean {
  if (step.family === "compaction") return true;
  return step.family === "warn" && step.events[0]?.source === CONTEXT_REASSEMBLED_SOURCE;
}

export interface StepFilter {
  /** Empty set = every kind (lifecycle markers included). */
  kinds: ReadonlySet<StepFilterKind>;
  /** null = every tool. */
  tool: string | null;
  query: string;
}

export const EMPTY_FILTER: StepFilter = { kinds: new Set(), tool: null, query: "" };

export function isFilterActive(f: StepFilter): boolean {
  return f.kinds.size > 0 || f.tool !== null || f.query.trim() !== "";
}

/**
 * Filter bucket of a step. Compaction spans / boundaries (and the
 * re-assembly warning) have their own bucket; other lifecycle markers only
 * match "error" when failed and are otherwise hidden by any kind filter.
 */
export function stepFilterKind(step: TraceStep): StepFilterKind | null {
  if (isCompactionRelated(step)) return "compaction";
  if (step.kind === "lifecycle") return step.isError ? "error" : null;
  return step.kind;
}

export function stepSearchText(step: TraceStep): string {
  const input = step.input === undefined ? "" : typeof step.input === "string" ? step.input : JSON.stringify(step.input);
  return [step.label, step.detail ?? "", step.text ?? "", input, step.output ?? "", step.errorText ?? ""].join("\n").toLowerCase();
}

export function stepMatches(s: TraceStep, filter: StepFilter): boolean {
  if (filter.kinds.size > 0) {
    const k = stepFilterKind(s);
    const errorMatch = filter.kinds.has("error") && s.isError;
    if (!errorMatch && (k === null || !filter.kinds.has(k))) return false;
  }
  if (filter.tool !== null && (s.kind !== "tool" || s.toolName !== filter.tool)) return false;
  const q = filter.query.trim().toLowerCase();
  if (q && !stepSearchText(s).includes(q)) return false;
  return true;
}

/** Lifecycle markers a kind filter hides because they have no kind bucket. */
export function hiddenLifecycleCount(steps: readonly TraceStep[], filter: StepFilter): number {
  if (filter.kinds.size === 0) return 0;
  return steps.filter((s) => stepFilterKind(s) === null && !(filter.kinds.has("error") && s.isError)).length;
}

export function filterSteps(steps: readonly TraceStep[], filter: StepFilter): TraceStep[] {
  return steps.filter((s) => stepMatches(s, filter));
}

/** Distinct tool names with call counts, most used first. */
export function toolCounts(steps: readonly TraceStep[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const s of steps) if (s.kind === "tool" && !s.orphan && s.toolName) counts.set(s.toolName, (counts.get(s.toolName) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ─── Copy text ───────────────────────────────────────────────────────

function stringifyInput(input: unknown): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  return JSON.stringify(input, null, 2);
}

function stepText(s: TraceStep): string {
  const dur = s.durationMs !== null && !s.instant ? ` · ${formatDuration(s.durationMs)}` : "";
  if (s.kind === "tool") {
    const head = `[tool ${s.toolName ?? s.label}${s.isError ? " · error" : ""}${s.pending ? " · pending" : ""}${s.orphan ? " · orphan" : ""}${dur}]`;
    const lines = [head];
    const input = stringifyInput(s.input);
    if (input) lines.push(`input: ${input}`);
    if (s.output !== undefined) lines.push(`output: ${s.output}`);
    return lines.join("\n");
  }
  if (s.kind === "model") return `[${s.label.toLowerCase()}${s.isError ? " · error" : ""}${s.pending ? " · pending" : ""}${dur}${s.detail ? ` · ${s.detail}` : ""}]`;
  const tag = s.kind === "lifecycle" ? s.label : s.kind;
  const body = s.text || s.errorText || s.detail || "";
  return `[${tag}${s.kind === "lifecycle" ? dur : ""}]${body ? ` ${body}` : ""}`;
}

/** Plain-text transcript of a trace, optionally limited to matching steps. */
export function transcriptText(p: TraceProjection, include: (s: TraceStep) => boolean = () => true): string {
  const blocks: string[] = [];
  const gapAfter = new Map(p.gaps.map((g) => [g.afterTurn, g]));
  for (const t of p.turns) {
    const steps = t.steps.filter(include);
    const dur = t.durationMs !== null ? ` · ${formatDuration(t.durationMs)}` : "";
    blocks.push(`## Turn ${t.index + 1} · ${turnTriggerLabel(t)} · ${t.turn.queued ? "queued" : t.turn.status}${dur}`);
    for (const s of steps) blocks.push(stepText(s));
    const g = gapAfter.get(t.index);
    if (g) blocks.push(`--- ${gapLabel(g)} ---`);
  }
  return blocks.join("\n\n");
}

// ─── Time scale (wall clock, optionally collapsed gaps) ──────────────

export interface CollapsedInterval {
  key: string;
  startTs: number;
  endTs: number;
}

export interface ScaleBreak extends CollapsedInterval {
  /** Display-space start / end of the collapsed marker. */
  d0: number;
  d1: number;
}

/**
 * Wall-clock time → display units. Identity (ms since start) unless some
 * gaps are collapsed; each collapsed gap shrinks to a small fixed width
 * while its true duration stays on the marker. Display units are ms
 * outside collapsed gaps, so durations and pixel density stay comparable.
 */
export interface TimeScale {
  startTs: number;
  endTs: number;
  total: number;
  breaks: ScaleBreak[];
  toDisplay(ts: number): number;
  toWall(d: number): number;
}

export function buildTimeScale(startTs: number, endTs: number, collapsed: readonly CollapsedInterval[] = []): TimeScale {
  const ivs = collapsed
    .map((c) => ({ ...c, startTs: Math.max(startTs, c.startTs), endTs: Math.min(endTs, c.endTs) }))
    .filter((c) => c.endTs > c.startTs)
    .sort((a, b) => a.startTs - b.startTs);
  // Drop overlaps (gaps are disjoint by construction; be defensive).
  const disjoint: typeof ivs = [];
  for (const c of ivs) if (!disjoint.length || c.startTs >= disjoint[disjoint.length - 1]!.endTs) disjoint.push(c);
  const span = Math.max(0, endTs - startTs);
  const removed = disjoint.reduce((n, c) => n + (c.endTs - c.startTs), 0);
  const unit = Math.max(1, (span - removed > 0 ? span - removed : span) * COLLAPSED_GAP_FRACTION);
  const widths = disjoint.map((c) => Math.min(unit, c.endTs - c.startTs));

  const toDisplay = (tsIn: number): number => {
    const ts = Math.min(endTs, Math.max(startTs, tsIn));
    let shift = 0;
    for (let k = 0; k < disjoint.length; k++) {
      const c = disjoint[k]!;
      const w = widths[k]!;
      if (ts <= c.startTs) break;
      const len = c.endTs - c.startTs;
      if (ts >= c.endTs) shift += len - w;
      else return c.startTs - startTs - shift + (w * (ts - c.startTs)) / len;
    }
    return ts - startTs - shift;
  };
  const toWall = (dIn: number): number => {
    let d = Math.max(0, dIn);
    let cursorT = startTs;
    for (let k = 0; k < disjoint.length; k++) {
      const c = disjoint[k]!;
      const w = widths[k]!;
      const seg = c.startTs - cursorT;
      if (d <= seg) return cursorT + d;
      d -= seg;
      if (d <= w) return c.startTs + (d / w) * (c.endTs - c.startTs);
      d -= w;
      cursorT = c.endTs;
    }
    return Math.min(endTs, cursorT + d);
  };
  const breaks = disjoint.map((c, k) => {
    const d0 = toDisplay(c.startTs);
    return { ...c, d0, d1: d0 + widths[k]! };
  });
  return { startTs, endTs, total: Math.max(1, toDisplay(endTs)), breaks, toDisplay, toWall };
}

/**
 * The original Timeline "auto" density: pxPerMs so the median gap between
 * consecutive span boundaries is ~25px, never wider than MAX_CHART_PX and
 * never narrower than fit-to-viewport.
 */
export function autoPxPerMs(boundaries: readonly number[], total: number, viewportPx: number): number {
  const fit = viewportPx / Math.max(total, 1);
  const sorted = [...boundaries].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i]! - sorted[i - 1]!;
    if (g > 0) gaps.push(g);
  }
  let candidate = fit;
  if (gaps.length) {
    gaps.sort((a, b) => a - b);
    candidate = 25 / (gaps[Math.floor(gaps.length / 2)] || 1);
  }
  return Math.min(MAX_CHART_PX / Math.max(total, 1), Math.max(fit, Math.min(5, candidate)));
}

// ─── Viewport (zoom / fit / brush) ───────────────────────────────────

export interface Viewport {
  pxPerMs: number;
  /** Clamped to [0, chart width − viewport]. */
  scrollLeft: number;
}

export interface ViewportBounds {
  /** Display units of the whole session. */
  total: number;
  viewportPx: number;
  /** Max px per display ms (manual zoom cap). */
  maxPxPerMs: number;
}

/** Fit-to-viewport density: the whole session in one screen. */
export function fitPxPerMs(b: ViewportBounds): number {
  return b.viewportPx / Math.max(1, b.total);
}

export function clampScroll(scrollLeft: number, pxPerMs: number, b: ViewportBounds): number {
  const max = Math.max(0, b.total * pxPerMs - b.viewportPx);
  return Math.min(max, Math.max(0, scrollLeft));
}

/**
 * Viewport showing display range [d0, d1]. The range is clamped to the
 * session, widened to a minimum span so a zero-length selection (an
 * instant) still zooms sensibly, and density stays within [fit, max].
 */
export function viewportForRange(d0In: number, d1In: number, b: ViewportBounds): Viewport {
  const fit = fitPxPerMs(b);
  const lo = Math.max(0, Math.min(d0In, d1In, b.total));
  const hi = Math.min(b.total, Math.max(d0In, d1In, 0));
  const minSpan = Math.max(b.total * 0.002, 1);
  let a = lo;
  let z = hi;
  if (z - a < minSpan) {
    const mid = (a + z) / 2;
    a = Math.max(0, mid - minSpan / 2);
    z = Math.min(b.total, a + minSpan);
    a = Math.max(0, z - minSpan);
  }
  const pxPerMs = Math.min(Math.max(fit, b.maxPxPerMs), Math.max(fit, b.viewportPx / (z - a)));
  // Centre the range when the clamp leaves it narrower than the viewport.
  const slack = Math.max(0, b.viewportPx - (z - a) * pxPerMs) / 2;
  return { pxPerMs, scrollLeft: clampScroll(a * pxPerMs - slack, pxPerMs, b) };
}

/** Zoom by `factor` keeping display point `centerD` in the viewport centre. */
export function zoomAround(centerD: number, pxPerMs: number, factor: number, b: ViewportBounds): Viewport {
  const fit = fitPxPerMs(b);
  const next = Math.min(Math.max(fit, b.maxPxPerMs), Math.max(fit, pxPerMs * factor));
  return { pxPerMs: next, scrollLeft: clampScroll(centerD * next - b.viewportPx / 2, next, b) };
}

/** Wall-clock window currently visible (real timestamps, collapsed gaps included). */
export function visibleWallRange(scale: TimeScale, v: Viewport, viewportPx: number): { startTs: number; endTs: number } {
  const d0 = v.scrollLeft / v.pxPerMs;
  const d1 = Math.min(scale.total, (v.scrollLeft + viewportPx) / v.pxPerMs);
  return { startTs: scale.toWall(d0), endTs: scale.toWall(d1) };
}

export interface Tick {
  ts: number;
  d: number;
}

/** Wall-clock ticks in the visible display window, skipping collapsed gaps. */
export function wallTicks(scale: TimeScale, d0: number, d1: number, pxPerMs: number): { step: number; ticks: Tick[] } {
  if (d1 <= d0 || pxPerMs <= 0) return { step: 0, ticks: [] };
  const desired = 120 / pxPerMs;
  let step = pickTickStep(desired * 6);
  while ((d1 - d0) / step > MAX_TICKS) step *= 2;
  const w0 = scale.toWall(d0);
  const w1 = scale.toWall(d1);
  const segments: Array<[number, number]> = [];
  let cursor = w0;
  for (const b of scale.breaks) {
    if (b.endTs <= w0 || b.startTs >= w1) continue;
    if (b.startTs > cursor) segments.push([cursor, b.startTs]);
    cursor = Math.max(cursor, b.endTs);
  }
  if (cursor < w1) segments.push([cursor, w1]);
  const ticks: Tick[] = [];
  for (const [a, b] of segments) {
    for (let t = Math.ceil(a / step) * step; t <= b && ticks.length < MAX_TICKS * 2; t += step) ticks.push({ ts: t, d: scale.toDisplay(t) });
  }
  return { step, ticks };
}

/** Local clock label, e.g. "7:50:05" (".250" appended for sub-second steps). */
export function formatClock(ts: number, stepMs = 1000): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const base = `${d.getHours()}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return stepMs < 1000 ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

// ─── Overview layout ─────────────────────────────────────────────────

export interface OverviewStepBar {
  step: TraceStep;
  turn: number;
  lane: number;
  d0: number;
  d1: number;
  /** End is not recorded; bar is drawn to the last observed event. */
  openEnded: boolean;
}

export interface OverviewTurnBar {
  turn: TraceTurn;
  d0: number;
  d1: number;
  openEnded: boolean;
}

export interface OverviewGapBar {
  gap: TraceGap;
  d0: number;
  d1: number;
  collapsed: boolean;
}

export interface OverviewMarker {
  step: TraceStep;
  turn: number;
  d: number;
  kind: OverviewMarkerKind;
}

export interface OverviewLayout {
  turnBars: OverviewTurnBar[];
  gapBars: OverviewGapBar[];
  stepBars: OverviewStepBar[];
  markers: OverviewMarker[];
  lanes: number;
  /** Display-space span boundaries, input to auto density. */
  boundaries: number[];
}

const MARKER_KINDS = new Set(["user", "error"]);

/** Which overview marker style an instant gets ("compaction" = boundary / orphan end). */
export type OverviewMarkerKind = "user" | "wakeup" | "error" | "compaction";

function markerKind(s: TraceStep): OverviewMarkerKind | null {
  if (s.isError) return "error";
  if (s.family === "compaction") return "compaction";
  if (s.family === "wakeup") return "wakeup";
  if (MARKER_KINDS.has(s.kind)) return s.kind === "error" ? "error" : "user";
  return null;
}

export function layoutOverview(p: TraceProjection, scale: TimeScale): OverviewLayout {
  const sessionEnd = p.endTs ?? scale.endTs;
  const turnBars: OverviewTurnBar[] = [];
  const stepBars: OverviewStepBar[] = [];
  const markers: OverviewMarker[] = [];
  const boundaries: number[] = [];
  const collapsedKeys = new Set(scale.breaks.map((b) => b.key));

  for (const t of p.turns) {
    if (t.startTs !== null) {
      const end = t.endTs ?? t.lastTs ?? t.startTs;
      turnBars.push({ turn: t, d0: scale.toDisplay(t.startTs), d1: scale.toDisplay(end), openEnded: !t.closed });
    }
    for (const s of t.steps) {
      if (s.startTs === null) continue;
      if (s.instant) {
        const kind = markerKind(s);
        if (kind) markers.push({ step: s, turn: t.index, d: scale.toDisplay(s.startTs), kind });
        continue;
      }
      const openEnded = s.endTs === null;
      const end = s.endTs ?? (s.pending ? sessionEnd : s.startTs);
      const d0 = scale.toDisplay(s.startTs);
      const d1 = scale.toDisplay(Math.max(end, s.startTs));
      boundaries.push(d0);
      if (d1 > d0) boundaries.push(d1);
      stepBars.push({ step: s, turn: t.index, lane: 0, d0, d1, openEnded });
    }
  }
  // Greedy lane packing in start order.
  const laneEnds: number[] = [];
  const byStart = [...stepBars].sort((a, b) => a.d0 - b.d0 || a.step.order - b.step.order);
  for (const b of byStart) {
    let lane = laneEnds.findIndex((end) => end <= b.d0);
    if (lane < 0) {
      if (laneEnds.length < MAX_OVERVIEW_LANES) {
        lane = laneEnds.length;
        laneEnds.push(0);
      } else lane = MAX_OVERVIEW_LANES - 1;
    }
    laneEnds[lane] = Math.max(laneEnds[lane]!, b.d1);
    b.lane = lane;
  }
  const gapBars: OverviewGapBar[] = p.gaps
    .filter((g) => g.startTs !== null && g.endTs !== null)
    .map((g) => ({ gap: g, d0: scale.toDisplay(g.startTs!), d1: scale.toDisplay(g.endTs!), collapsed: collapsedKeys.has(g.key) }));
  return { turnBars, gapBars, stepBars, markers, lanes: Math.max(1, laneEnds.length), boundaries };
}

// ─── Diffs / misc ────────────────────────────────────────────────────

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const DIFF_HINT = /^(diff --git |--- |\+\+\+ |@@ |\*\*\* Begin Patch)/m;

/**
 * Detect a file-edit payload and render it as diff lines. Recognises
 * edit-tool inputs (`old_string`/`new_string`, `old_str`/`new_str`) and
 * unified diff / apply_patch text in `patch`, `diff`, or the raw string.
 * Returns null when the input doesn't look like an edit.
 */
export function extractDiff(input: unknown): { path?: string; lines: DiffLine[] } | null {
  const obj = isRecord(input) ? input : undefined;
  const path = obj && typeof (obj.file_path ?? obj.path) === "string" ? String(obj.file_path ?? obj.path) : undefined;
  if (obj) {
    const oldS = obj.old_string ?? obj.old_str;
    const newS = obj.new_string ?? obj.new_str;
    if (typeof oldS === "string" && typeof newS === "string") {
      const lines: DiffLine[] = [
        ...oldS.split("\n").map((t): DiffLine => ({ kind: "del", text: `-${t}` })),
        ...newS.split("\n").map((t): DiffLine => ({ kind: "add", text: `+${t}` })),
      ];
      return { path, lines };
    }
  }
  const text = typeof input === "string" ? input
    : obj && typeof obj.patch === "string" ? obj.patch
    : obj && typeof obj.diff === "string" ? obj.diff
    : obj && typeof obj.input === "string" ? obj.input
    : null;
  if (!text || !DIFF_HINT.test(text)) return null;
  const lines = text.split("\n").map((t): DiffLine => {
    if (t.startsWith("+++") || t.startsWith("---") || t.startsWith("diff ") || t.startsWith("***")) return { kind: "meta", text: t };
    if (t.startsWith("@@")) return { kind: "hunk", text: t };
    if (t.startsWith("+")) return { kind: "add", text: t };
    if (t.startsWith("-")) return { kind: "del", text: t };
    return { kind: "ctx", text: t };
  });
  return { path, lines };
}

/** Compact token count: 950, 1.2k, 3.4M. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
