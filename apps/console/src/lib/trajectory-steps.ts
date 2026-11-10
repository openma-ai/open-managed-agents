// Trajectory projection: raw event stream → steps, turns, lanes, text.
//
// Pure helpers behind the Trajectory viewer modal. They accept both the
// envelope's `StoredEvent` rows (`{ seq, type, data: "<json>", ts }`) and
// already-unwrapped session events (`{ type, content | text, tool_use_id, … }`)
// so the same projection works for `GET /v1/oma/sessions/:id/trajectory`,
// live session events, and hand-written fixtures.
//
// Vocabulary:
//   - step  — one row in the transcript. A tool call and its result are
//             paired into a single step by call id; messages, thinking,
//             errors and outcome evaluations are one step each.
//   - turn  — one model iteration: everything from a trigger (user message,
//             or the model resuming after tool results / a new model
//             request) until the next trigger.
//   - row   — a step, or a group of 3+ consecutive same-tool calls.

import { formatDuration } from "./format";

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

export type StepKind = "user" | "assistant" | "thinking" | "tool" | "error" | "outcome" | "status";

export type ToolSource = "builtin" | "mcp" | "custom";

export interface TrajectoryStep {
  id: string;
  kind: StepKind;
  /** Turn index this step belongs to (0-based). */
  turn: number;
  /** Short badge label: tool name, "User", "Assistant", … */
  label: string;
  /** One-line summary for the step row. */
  summary: string;
  /** Full text body (messages, thinking, errors, outcome feedback). */
  text?: string;
  startMs: number | null;
  endMs: number | null;
  /** End − start when both are known and the step is paired. */
  durationMs: number | null;
  // Tool-only fields.
  toolName?: string;
  toolSource?: ToolSource;
  mcpServer?: string;
  callId?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  /** Tool call with no result yet. */
  pending?: boolean;
  /** Tool result with no matching call. */
  orphan?: boolean;
  /** Source events (call + result for paired tools). */
  events: TrajectoryEvent[];
}

export interface TrajectoryGroupRow {
  kind: "group";
  id: string;
  toolName: string;
  steps: TrajectoryStep[];
  startMs: number | null;
  endMs: number | null;
  errors: number;
}

export type TrajectoryRow = TrajectoryStep | TrajectoryGroupRow;

export type TurnTrigger = "start" | "user" | "tool_results" | "model_request";

export interface TrajectoryTurn {
  index: number;
  trigger: TurnTrigger;
  stepIds: string[];
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  toolCalls: number;
  errors: number;
  messages: number;
  modelRequests: number;
  inputTokens: number;
  outputTokens: number;
  /** True for the turn holding the final assistant message. */
  isFinal: boolean;
}

export interface ModelSpan {
  turn: number;
  startMs: number;
  endMs: number | null;
  isError: boolean;
  inputTokens: number;
  outputTokens: number;
}

export interface TrajectoryProjection {
  events: TrajectoryEvent[];
  steps: TrajectoryStep[];
  turns: TrajectoryTurn[];
  modelSpans: ModelSpan[];
  /** First user message text — the "question". */
  question: string | null;
  /** Last assistant message text — the "answer". */
  answer: string | null;
  startMs: number | null;
  endMs: number | null;
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

/** Flatten `content` (string or content blocks) or a bare `text` field. */
export function eventText(raw: Record<string, unknown>): string {
  const content = raw.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (isRecord(block)) {
        if (typeof block.text === "string") parts.push(block.text);
        else if (typeof block.thinking === "string") parts.push(block.thinking);
        else if (typeof block.type === "string") parts.push(`[${block.type}]`);
      }
    }
    if (parts.length) return parts.join("\n");
  }
  for (const key of ["text", "thinking", "message", "error", "feedback", "explanation"]) {
    const v = raw[key];
    if (typeof v === "string" && v) return v;
    if (isRecord(v) && typeof v.message === "string") return v.message;
  }
  return "";
}

/** First non-empty line, trimmed to `max` chars. */
export function oneLine(text: string, max = 140): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const SHELL_TOOLS = new Set(["bash", "shell", "sh", "terminal", "exec", "run_command"]);

export function isShellTool(name: string | undefined): boolean {
  return !!name && SHELL_TOOLS.has(name.toLowerCase());
}

/** Human summary of a tool input: the most telling field, else compact JSON. */
export function summarizeToolInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return oneLine(input);
  if (!isRecord(input)) return oneLine(JSON.stringify(input));
  for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "message"]) {
    const v = input[key];
    if (typeof v === "string" && v) return oneLine(v);
  }
  const json = JSON.stringify(input);
  return json === "{}" ? "" : oneLine(json);
}

function readError(raw: Record<string, unknown>): boolean {
  if (raw.is_error === true) return true;
  if (typeof raw.error === "string" && raw.error) return true;
  if (isRecord(raw.error)) return true;
  return false;
}

// ─── Projection ──────────────────────────────────────────────────────

interface CallSlot {
  step: TrajectoryStep;
}

/** Build steps and turns from the normalized event stream. */
export function projectTrajectory(input: readonly unknown[] | undefined | null): TrajectoryProjection {
  const events = normalizeEvents(input);
  const steps: TrajectoryStep[] = [];
  const turns: TrajectoryTurn[] = [];
  const modelSpans: ModelSpan[] = [];
  const openCalls = new Map<string, CallSlot>();
  const openModel = new Map<string, ModelSpan>();
  const openModelFifo: ModelSpan[] = [];

  let current = null as TrajectoryTurn | null;
  /** Set once a turn has seen agent output; a later model request starts a new turn. */
  let currentHasOutput = false;
  /** Set once tool results land; the next agent output starts a new turn. */
  let awaitingModel = false;

  const newTurn = (trigger: TurnTrigger, ts: number | null): TrajectoryTurn => {
    const t: TrajectoryTurn = {
      index: turns.length,
      trigger,
      stepIds: [],
      startMs: ts,
      endMs: ts,
      durationMs: null,
      toolCalls: 0,
      errors: 0,
      messages: 0,
      modelRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      isFinal: false,
    };
    turns.push(t);
    current = t;
    currentHasOutput = false;
    awaitingModel = false;
    return t;
  };
  const turnFor = (ts: number | null): TrajectoryTurn => current ?? newTurn("start", ts);
  const touch = (turn: TrajectoryTurn, ts: number | null) => {
    if (ts === null) return;
    if (turn.startMs === null || ts < turn.startMs) turn.startMs = ts;
    if (turn.endMs === null || ts > turn.endMs) turn.endMs = ts;
  };
  const agentOutput = (ts: number | null): TrajectoryTurn => {
    if (awaitingModel && current) newTurn("tool_results", ts);
    const t = turnFor(ts);
    currentHasOutput = true;
    return t;
  };
  const push = (turn: TrajectoryTurn, step: TrajectoryStep) => {
    steps.push(step);
    turn.stepIds.push(step.id);
    touch(turn, step.startMs);
    if (step.kind === "error" || step.isError) turn.errors += 1;
  };
  const stepId = (e: TrajectoryEvent) => {
    const id = e.raw.id;
    return typeof id === "string" && id ? `${e.type}:${id}` : `${e.type}#${e.index}`;
  };

  for (const e of events) {
    const raw = e.raw;
    switch (e.type) {
      case "user.message": {
        const turn = newTurn("user", e.ts);
        const text = eventText(raw);
        push(turn, {
          id: stepId(e), kind: "user", turn: turn.index, label: "User",
          summary: oneLine(text) || "(empty message)", text,
          startMs: e.ts, endMs: e.ts, durationMs: null, events: [e],
        });
        break;
      }
      case "agent.message":
      case "agent.thinking": {
        const turn = agentOutput(e.ts);
        const text = eventText(raw);
        const isMsg = e.type === "agent.message";
        if (isMsg) turn.messages += 1;
        push(turn, {
          id: stepId(e), kind: isMsg ? "assistant" : "thinking", turn: turn.index,
          label: isMsg ? "Assistant" : "Thinking",
          summary: oneLine(text) || (isMsg ? "(empty message)" : "(redacted thinking)"), text,
          startMs: e.ts, endMs: e.ts, durationMs: null, events: [e],
        });
        break;
      }
      case "agent.tool_use":
      case "agent.mcp_tool_use":
      case "agent.custom_tool_use": {
        const turn = agentOutput(e.ts);
        turn.toolCalls += 1;
        const name = typeof raw.name === "string" && raw.name ? raw.name : "tool";
        const source: ToolSource = e.type === "agent.mcp_tool_use" ? "mcp" : e.type === "agent.custom_tool_use" ? "custom" : "builtin";
        const callId = typeof raw.id === "string" && raw.id ? raw.id : undefined;
        const step: TrajectoryStep = {
          id: stepId(e), kind: "tool", turn: turn.index, label: name,
          summary: summarizeToolInput(raw.input) || name,
          startMs: e.ts, endMs: null, durationMs: null,
          toolName: name, toolSource: source,
          mcpServer: typeof raw.mcp_server_name === "string" ? raw.mcp_server_name : undefined,
          callId, input: raw.input, pending: true, events: [e],
        };
        push(turn, step);
        if (callId) openCalls.set(callId, { step });
        break;
      }
      case "agent.tool_result":
      case "agent.mcp_tool_result":
      case "user.custom_tool_result": {
        const callId = [raw.tool_use_id, raw.mcp_tool_use_id, raw.custom_tool_use_id].find(
          (v): v is string => typeof v === "string" && !!v,
        );
        const output = eventText(raw);
        const isError = readError(raw);
        const slot = callId ? openCalls.get(callId) : undefined;
        if (slot) {
          openCalls.delete(callId!);
          const s = slot.step;
          s.events.push(e);
          s.output = output;
          s.isError = isError;
          s.pending = false;
          s.endMs = e.ts;
          s.durationMs = s.startMs !== null && e.ts !== null ? Math.max(0, e.ts - s.startMs) : null;
          const turn = turns[s.turn]!;
          if (isError) turn.errors += 1;
          touch(turn, e.ts);
        } else {
          // Orphan result: keep it visible so nothing silently disappears.
          const turn = turnFor(e.ts);
          push(turn, {
            id: stepId(e), kind: "tool", turn: turn.index, label: "result",
            summary: oneLine(output) || "(orphan tool result)",
            startMs: e.ts, endMs: e.ts, durationMs: null,
            toolName: "result", callId, output, isError, orphan: true, events: [e],
          });
        }
        if (current) awaitingModel = true;
        break;
      }
      case "session.error": {
        const turn = turnFor(e.ts);
        const text = eventText(raw) || "Session error";
        push(turn, {
          id: stepId(e), kind: "error", turn: turn.index, label: "Error",
          summary: oneLine(text), text, startMs: e.ts, endMs: e.ts, durationMs: null,
          isError: true, events: [e],
        });
        break;
      }
      case "session.outcome_evaluated": {
        const turn = turnFor(e.ts);
        const result = typeof raw.result === "string" ? raw.result : "evaluated";
        const text = eventText(raw);
        push(turn, {
          id: stepId(e), kind: "outcome", turn: turn.index, label: "Outcome",
          summary: text ? `${result} — ${oneLine(text, 100)}` : result, text,
          startMs: e.ts, endMs: e.ts, durationMs: null,
          isError: result === "failed", events: [e],
        });
        break;
      }
      case "user.interrupt":
      case "session.status_terminated": {
        const turn = turnFor(e.ts);
        const label = e.type === "user.interrupt" ? "Interrupt" : "Terminated";
        const reason = typeof raw.reason === "string" ? raw.reason : "";
        push(turn, {
          id: stepId(e), kind: "status", turn: turn.index, label,
          summary: reason || (e.type === "user.interrupt" ? "User interrupted the run" : "Session terminated"),
          startMs: e.ts, endMs: e.ts, durationMs: null, events: [e],
        });
        break;
      }
      case "span.model_request_start": {
        if (current && awaitingModel) newTurn("tool_results", e.ts);
        else if (current && currentHasOutput) newTurn("model_request", e.ts);
        const turn = turnFor(e.ts);
        turn.modelRequests += 1;
        touch(turn, e.ts);
        if (e.ts !== null) {
          const span: ModelSpan = { turn: turn.index, startMs: e.ts, endMs: null, isError: false, inputTokens: 0, outputTokens: 0 };
          modelSpans.push(span);
          openModelFifo.push(span);
          const id = raw.id;
          if (typeof id === "string" && id) openModel.set(id, span);
        }
        break;
      }
      case "span.model_request_end": {
        const data = isRecord(raw.data) ? raw.data : {};
        const startId = raw.model_request_start_id ?? data.model_request_start_id;
        let span = typeof startId === "string" ? openModel.get(startId) : undefined;
        if (span) {
          openModel.delete(startId as string);
          openModelFifo.splice(openModelFifo.indexOf(span), 1);
        } else {
          span = openModelFifo.shift();
        }
        const usage = (raw.model_usage ?? data.model_usage) as { input_tokens?: number; output_tokens?: number } | undefined;
        const inTok = typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
        const outTok = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
        const isError = raw.is_error === true || data.is_error === true;
        const turn = span ? turns[span.turn]! : current;
        if (turn) {
          turn.inputTokens += inTok;
          turn.outputTokens += outTok;
          touch(turn, e.ts);
        }
        if (span) {
          span.endMs = e.ts;
          span.isError = isError;
          span.inputTokens = inTok;
          span.outputTokens = outTok;
        }
        break;
      }
      default: {
        // Lifecycle / streaming noise is not a step, but it still bounds time.
        if (current) touch(current, e.ts);
      }
    }
  }

  for (const t of turns) {
    t.durationMs = t.startMs !== null && t.endMs !== null ? t.endMs - t.startMs : null;
  }
  const finalStep = [...steps].reverse().find((s) => s.kind === "assistant");
  if (finalStep) turns[finalStep.turn]!.isFinal = true;

  const timed = events.map((e) => e.ts).filter((t): t is number => t !== null);
  return {
    events,
    steps,
    turns,
    modelSpans,
    question: steps.find((s) => s.kind === "user")?.text ?? null,
    answer: finalStep?.text ?? null,
    startMs: timed.length ? Math.min(...timed) : null,
    endMs: timed.length ? Math.max(...timed) : null,
  };
}

// ─── Grouping ────────────────────────────────────────────────────────

export const MIN_GROUP_SIZE = 3;

/** Fold runs of MIN_GROUP_SIZE+ consecutive same-tool, non-shell calls. */
export function groupSteps(steps: readonly TrajectoryStep[]): TrajectoryRow[] {
  const rows: TrajectoryRow[] = [];
  let i = 0;
  while (i < steps.length) {
    const s = steps[i]!;
    const foldable = s.kind === "tool" && !s.orphan && !isShellTool(s.toolName);
    let j = i + 1;
    if (foldable) {
      while (j < steps.length && steps[j]!.kind === "tool" && !steps[j]!.orphan && steps[j]!.toolName === s.toolName) j++;
    }
    const run = steps.slice(i, j);
    if (foldable && run.length >= MIN_GROUP_SIZE) {
      const starts = run.map((r) => r.startMs).filter((t): t is number => t !== null);
      const ends = run.map((r) => r.endMs ?? r.startMs).filter((t): t is number => t !== null);
      rows.push({
        kind: "group",
        id: `group:${run[0]!.id}`,
        toolName: s.toolName!,
        steps: run,
        startMs: starts.length ? Math.min(...starts) : null,
        endMs: ends.length ? Math.max(...ends) : null,
        errors: run.filter((r) => r.isError).length,
      });
    } else {
      rows.push(s);
      j = i + 1;
    }
    i = j;
  }
  return rows;
}

export function isGroupRow(row: TrajectoryRow): row is TrajectoryGroupRow {
  return row.kind === "group";
}

// ─── Filters ─────────────────────────────────────────────────────────

/** Filter buckets offered in the UI. Tool calls of every source share "tool". */
export type StepFilterKind = "user" | "assistant" | "thinking" | "tool" | "error";

export const STEP_FILTER_KINDS: StepFilterKind[] = ["user", "assistant", "thinking", "tool", "error"];

export interface StepFilter {
  /** Empty set = every kind. */
  kinds: ReadonlySet<StepFilterKind>;
  /** null = every tool. */
  tool: string | null;
  query: string;
}

export const EMPTY_FILTER: StepFilter = { kinds: new Set(), tool: null, query: "" };

/** Which filter bucket a step falls into. Outcome/status rows ride with "error"
 *  when they failed and are otherwise always shown. */
export function stepFilterKind(step: TrajectoryStep): StepFilterKind | null {
  if (step.kind === "error") return "error";
  if (step.kind === "outcome" || step.kind === "status") return step.isError ? "error" : null;
  return step.kind;
}

export function stepSearchText(step: TrajectoryStep): string {
  const input = step.input === undefined ? "" : typeof step.input === "string" ? step.input : JSON.stringify(step.input);
  return [step.label, step.summary, step.text ?? "", input, step.output ?? ""].join("\n").toLowerCase();
}

export function filterSteps(steps: readonly TrajectoryStep[], filter: StepFilter): TrajectoryStep[] {
  const q = filter.query.trim().toLowerCase();
  return steps.filter((s) => {
    if (filter.kinds.size > 0) {
      const k = stepFilterKind(s);
      const errorMatch = filter.kinds.has("error") && (s.isError || s.kind === "error");
      if (!errorMatch && (k === null || !filter.kinds.has(k))) return false;
    }
    if (filter.tool !== null && (s.kind !== "tool" || s.toolName !== filter.tool)) return false;
    if (q && !stepSearchText(s).includes(q)) return false;
    return true;
  });
}

/** Distinct tool names with call counts, most used first. */
export function toolCounts(steps: readonly TrajectoryStep[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const s of steps) if (s.kind === "tool" && s.toolName) counts.set(s.toolName, (counts.get(s.toolName) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ─── Wall-clock lanes ────────────────────────────────────────────────

export type LaneName = "model" | "tools";

export interface LaneSegment {
  lane: LaneName;
  /** Step to seek to when the segment is clicked. */
  stepId: string;
  turn: number;
  /** Offsets from run start, in ms. */
  startMs: number;
  endMs: number;
  tone: "ok" | "error" | "pending";
  label: string;
}

export interface TrajectoryLanes {
  totalMs: number;
  segments: LaneSegment[];
}

/** Runs shorter than this hide the timeline — there's nothing to see. */
export const MIN_TIMELINE_MS = 1000;

/**
 * Two-lane wall-clock layout. Model lane: model request spans when the
 * stream has them, else message/thinking markers. Tool lane: paired tool
 * calls. Colour encodes success/failure only. Returns null when the run
 * is untimed or too short to be worth drawing.
 */
export function buildLanes(p: TrajectoryProjection): TrajectoryLanes | null {
  if (p.startMs === null || p.endMs === null) return null;
  const totalMs = p.endMs - p.startMs;
  if (totalMs < MIN_TIMELINE_MS) return null;
  const t0 = p.startMs;
  const segments: LaneSegment[] = [];
  // Seek target for a model span: the first step of its turn; a turn that
  // holds only an in-flight request falls back to the last earlier step.
  const seekTargetForTurn = (turn: number): string | undefined => {
    const own = p.turns[turn]?.stepIds[0];
    if (own) return own;
    for (let i = turn - 1; i >= 0; i--) {
      const ids = p.turns[i]!.stepIds;
      if (ids.length) return ids[ids.length - 1];
    }
    return undefined;
  };

  if (p.modelSpans.length > 0) {
    p.modelSpans.forEach((m, i) => {
      const stepId = seekTargetForTurn(m.turn);
      if (!stepId) return;
      segments.push({
        lane: "model", stepId, turn: m.turn,
        startMs: m.startMs - t0, endMs: (m.endMs ?? p.endMs!) - t0,
        tone: m.isError ? "error" : m.endMs === null ? "pending" : "ok",
        label: `Model request ${i + 1}`,
      });
    });
  }
  for (const s of p.steps) {
    if (s.startMs === null) continue;
    if (s.kind === "tool") {
      segments.push({
        lane: "tools", stepId: s.id, turn: s.turn,
        startMs: s.startMs - t0, endMs: (s.endMs ?? (s.pending ? p.endMs! : s.startMs)) - t0,
        tone: s.isError ? "error" : s.pending ? "pending" : "ok",
        label: `${s.label}: ${s.summary}`,
      });
    } else if (p.modelSpans.length === 0 || s.kind === "error") {
      segments.push({
        lane: "model", stepId: s.id, turn: s.turn,
        startMs: s.startMs - t0, endMs: s.startMs - t0,
        tone: s.isError || s.kind === "error" ? "error" : "ok",
        label: `${s.label}: ${s.summary}`,
      });
    }
  }
  return { totalMs, segments };
}

/** Segment placement in percent of the track, with a minimum visible width. */
export function segmentPosition(seg: LaneSegment, totalMs: number, minPct = 0.6): { left: number; width: number } {
  const left = Math.min(100, Math.max(0, (seg.startMs / totalMs) * 100));
  const raw = ((seg.endMs - seg.startMs) / totalMs) * 100;
  const width = Math.min(100 - left, Math.max(minPct, raw));
  return { left, width };
}

// ─── Copy text / diffs / misc ────────────────────────────────────────

function stringifyInput(input: unknown): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  return JSON.stringify(input, null, 2);
}

/** Plain-text transcript of the given steps, for "Copy all". */
export function transcriptText(steps: readonly TrajectoryStep[]): string {
  const blocks: string[] = [];
  let lastTurn = -1;
  for (const s of steps) {
    if (s.turn !== lastTurn) {
      blocks.push(`## Turn ${s.turn + 1}`);
      lastTurn = s.turn;
    }
    if (s.kind === "tool") {
      const head = `[tool ${s.toolName ?? s.label}${s.isError ? " · error" : ""}${s.pending ? " · pending" : ""}${s.durationMs !== null ? ` · ${formatDuration(s.durationMs)}` : ""}]`;
      const lines = [head];
      const input = stringifyInput(s.input);
      if (input) lines.push(`input: ${input}`);
      if (s.output !== undefined) lines.push(`output: ${s.output}`);
      blocks.push(lines.join("\n"));
    } else {
      blocks.push(`[${s.label.toLowerCase()}] ${s.text || s.summary}`);
    }
  }
  return blocks.join("\n\n");
}

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
