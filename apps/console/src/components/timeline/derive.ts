import { formatDuration } from "../../lib/format";
import type { Event } from "../../lib/events";
import { isQueuedSessionEvent } from "../../lib/session-event-queue";
import { eventTsMs } from "./eventTime";
import type { CompactionInfo, ModelUsage, TraceStep, Turn, TurnTriggerKind } from "./types";

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Field on the event, falling back to span `data`. */
function field(e: Event, key: string): unknown {
  const top = (e as Rec)[key];
  if (top !== undefined) return top;
  const data = e.data;
  return isRecord(data) ? data[key] : undefined;
}

/** Epoch ms or null — the trace never treats a missing time as 0. */
export function eventTsOrNull(e: Event): number | null {
  const t = eventTsMs(e);
  return t > 0 ? t : null;
}

/** Flatten `content` (string or blocks) or a bare text-ish field. */
export function eventText(raw: Rec): string {
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
  for (const key of ["text", "thinking", "message", "error", "error_message", "feedback", "explanation"]) {
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

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** model_usage only when it really carries token counts. */
function reportedUsage(v: unknown): ModelUsage | undefined {
  if (!isRecord(v) || typeof v.input_tokens !== "number" || typeof v.output_tokens !== "number") return undefined;
  return v as unknown as ModelUsage;
}

function usageText(u: ModelUsage): string {
  return `${u.input_tokens}↓ ${u.output_tokens}↑${u.cache_read_input_tokens ? ` ⚡${u.cache_read_input_tokens}` : ""}`;
}

/** Copy the fields agent.thread_context_compacted actually carries. */
function boundaryInfo(e: Event): CompactionInfo {
  const info: CompactionInfo = { role: "boundary" };
  const summary = field(e, "summary");
  if (typeof summary === "string" && summary) info.summary = summary;
  else if (Array.isArray(summary)) {
    const text = eventText({ content: summary });
    if (text) info.summary = text;
  }
  const orig = num(field(e, "original_message_count"));
  if (orig !== undefined) info.originalMessageCount = orig;
  const comp = num(field(e, "compacted_message_count"));
  if (comp !== undefined) info.compactedMessageCount = comp;
  const trigger = str(field(e, "trigger"));
  if (trigger) info.trigger = trigger;
  const pre = num(field(e, "pre_tokens"));
  if (pre !== undefined) info.preTokens = pre;
  const range = field(e, "replaced_range");
  if (isRecord(range) && num(range.start_seq) !== undefined && num(range.end_seq) !== undefined) {
    info.replacedRange = { startSeq: range.start_seq as number, endSeq: range.end_seq as number };
  }
  return info;
}

/** Summarize-span fields from span.compaction_summarize_end (if any). */
function summarizeFields(start: Event | undefined, end: Event | undefined) {
  const usage = end ? reportedUsage(field(end, "model_usage")) : undefined;
  const finishReason = end ? str(field(end, "finish_reason")) : undefined;
  const model = (start ? str(field(start, "model")) : undefined) ?? (end ? str(field(end, "model")) : undefined);
  const finalTextLength = end ? num(field(end, "final_text_length")) : undefined;
  // The Pi strategy reports a failed summarize call as finish_reason "error".
  const isError = finishReason === "error";
  return {
    model,
    usage,
    finishReason,
    finalTextLength,
    isError,
    detail: [finishReason, usage ? usageText(usage) : undefined].filter(Boolean).join(" · ") || undefined,
  };
}

function resultIsError(raw: Rec): boolean {
  if (raw.is_error === true) return true;
  if (typeof raw.error === "string" && raw.error) return true;
  return isRecord(raw.error);
}

// Streaming chunks (deltas + start/end markers from incremental
// rendering) are broadcast-only; the canonical event (agent.message /
// agent.thinking) lands on commit and is what the trace should show.
const STREAMING_NOISE = new Set([
  "agent.message_chunk",
  "agent.message_stream_start",
  "agent.message_stream_end",
  "agent.thinking_chunk",
  "agent.thinking_stream_start",
  "agent.thinking_stream_end",
  "agent.tool_use_input_chunk",
  "agent.tool_use_input_stream_start",
  "agent.tool_use_input_stream_end",
]);

const THREAD_MARKERS = new Set([
  "agent.thread_message_sent",
  "agent.thread_message_received",
  "agent.thread_message",
  "session.thread_created",
  // A sub-agent thread went idle. Zero-duration thread marker — NOT the
  // between-turn idle (that comes only from session.status_idle closing a
  // turn; see bucketIntoTurns).
  "session.thread_idle",
]);

interface Timed { e: Event; t: number | null; i: number }

/**
 * Derive Trace steps from a whole session's event stream.
 *
 * Successor of the original Timeline `deriveSpans`: same families, labels
 * and pairing rules (tool_use ↔ tool_result by call id, model_request
 * start ↔ end by model_request_start_id with FIFO fallback, wakeup
 * scheduled ↔ fired user.message by parent_event_id, compaction/outcome
 * FIFO). Differences, all toward truthfulness:
 *   - pairing runs over the whole session, so a custom tool whose result
 *     opens the next turn, or a schedule wait fired in the next turn,
 *     still pairs;
 *   - untimed events stay visible with `null` times instead of being
 *     dropped;
 *   - unpaired results surface as orphan steps; unanswered calls stay
 *     `pending`;
 *   - tool errors (is_error / error) and model errors are flagged.
 *
 * timestamp basis is OpenMA `occurred_at` / client `ts` (see eventTsMs).
 */
export function deriveTraceSteps(events: readonly Event[]): TraceStep[] {
  const timed: Timed[] = events.map((e, i) => ({ e, t: eventTsOrNull(e), i }));

  // ── Pass 1: index pairings ──────────────────────────────────────────
  const useIds = new Set<string>();
  for (const { e } of timed) {
    if (e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use" || e.type === "agent.custom_tool_use") {
      const id = str(e.id);
      if (id) useIds.add(id);
    }
  }
  const resultCallId = (e: Event): string | undefined =>
    str(e.tool_use_id) ?? str(e.mcp_tool_use_id) ?? str(field(e, "custom_tool_use_id")) ?? str(field(e, "parent_event_id"));
  const results = new Map<string, Timed>();
  const pairedResults = new Set<number>();
  for (const x of timed) {
    if (x.e.type !== "agent.tool_result" && x.e.type !== "agent.mcp_tool_result" && x.e.type !== "user.custom_tool_result") continue;
    let cid = resultCallId(x.e);
    // Legacy custom tool results carried the call id as their own id.
    if (!cid && x.e.type === "user.custom_tool_result") cid = str(x.e.id);
    if (cid && useIds.has(cid) && !results.has(cid)) {
      results.set(cid, x);
      pairedResults.add(x.i);
    }
  }

  type ModelEnd = Timed & { sid?: string };
  const modelEndsById = new Map<string, ModelEnd>();
  const modelEndsNoId: ModelEnd[] = [];
  const firstTokById = new Map<string, Timed>();
  const firstTokNoId: Timed[] = [];
  const compactEnds: Timed[] = [];
  const outcomeEnds: Timed[] = [];
  const childByParent = new Map<string, Timed>();
  for (const x of timed) {
    const { e } = x;
    if (e.type === "span.model_request_end") {
      const sid = str(field(e, "model_request_start_id"));
      if (sid) modelEndsById.set(sid, { ...x, sid });
      else modelEndsNoId.push(x);
    } else if (e.type === "span.model_first_token") {
      const sid = str(field(e, "model_request_start_id"));
      if (sid) firstTokById.set(sid, x);
      else firstTokNoId.push(x);
    } else if (e.type === "span.compaction_summarize_end") compactEnds.push(x);
    else if (e.type === "span.outcome_evaluation_end") outcomeEnds.push(x);
    const pid = str(field(e, "parent_event_id"));
    if (pid && e.type === "user.message") childByParent.set(pid, x);
  }
  let outcomeIdx = 0;
  const takeAfter = (list: Timed[], i: number): Timed | undefined => {
    const k = list.findIndex((x) => x.i > i);
    return k >= 0 ? list.splice(k, 1)[0] : undefined;
  };

  // ── Pass 2: build steps in stream order ─────────────────────────────
  const steps: TraceStep[] = [];
  const durationOf = (a: number | null, b: number | null) => (a !== null && b !== null ? Math.max(0, b - a) : null);

  for (const { e, t, i } of timed) {
    if (STREAMING_NOISE.has(e.type)) continue;
    const base = {
      startTs: t,
      order: i,
      threadId: str(field(e, "session_thread_id")),
      parentEventId: str(field(e, "parent_event_id")),
      events: [e] as Event[],
      isError: false,
      pending: false,
      orphan: false,
    };
    const instant = (s: Omit<TraceStep, keyof typeof base | "endTs" | "durationMs" | "instant"> & Partial<TraceStep>) =>
      steps.push({ ...base, endTs: null, durationMs: 0, instant: true, ...s });
    const ranged = (s: Omit<TraceStep, keyof typeof base | "endTs" | "durationMs" | "instant"> & Partial<TraceStep>, end: Timed | undefined) => {
      if (end) base.events.push(end.e);
      steps.push({
        ...base,
        endTs: end ? end.t : null,
        durationMs: end ? durationOf(t, end.t) : null,
        instant: false,
        pending: !end,
        ...s,
      });
    };
    const id = str(e.id);

    if (e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use" || e.type === "agent.custom_tool_use") {
      const result = id ? results.get(id) : undefined;
      const name = str(e.name) ?? "tool";
      const isMcp = e.type === "agent.mcp_tool_use";
      const server = str(e.mcp_server_name);
      const out = result ? eventText(result.e as Rec) : undefined;
      ranged({
        key: `${isMcp ? "mcp" : "tool"}-${id ?? i}`,
        family: isMcp ? "mcp" : e.type === "agent.tool_use" ? "tool" : "custom_tool",
        kind: "tool",
        label: isMcp ? `${server ?? "mcp"}:${name}` : name,
        detail: summarizeToolInput(e.input) || undefined,
        toolName: name,
        toolSource: isMcp ? "mcp" : e.type === "agent.custom_tool_use" ? "custom" : "builtin",
        mcpServer: server,
        callId: id,
        input: e.input,
        output: out,
        isError: result ? resultIsError(result.e as Rec) : false,
        errorText: result && resultIsError(result.e as Rec) ? out || eventText({ error: (result.e as Rec).error }) : undefined,
      }, result);
    } else if (e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result" || e.type === "user.custom_tool_result") {
      if (pairedResults.has(i)) {
        // A paired custom tool result still opens its own turn (it is a
        // turn trigger); keep a lifecycle marker there so the trigger row
        // isn't empty. Built-in/MCP results are folded into the call.
        if (e.type === "user.custom_tool_result") {
          instant({ key: `ctr-${id ?? i}`, family: "custom_tool", kind: "lifecycle", label: "custom tool result", detail: oneLine(eventText(e as Rec)) || undefined, callId: resultCallId(e) ?? id });
        }
        continue;
      }
      const out = eventText(e as Rec);
      const err = resultIsError(e as Rec);
      instant({
        key: `orphan-${id ?? i}`,
        family: e.type === "agent.mcp_tool_result" ? "mcp" : e.type === "agent.tool_result" ? "tool" : "custom_tool",
        kind: "tool",
        label: "tool result (no matching call)",
        detail: oneLine(out) || undefined,
        toolName: "result",
        callId: resultCallId(e),
        output: out,
        isError: err,
        errorText: err ? out : undefined,
        orphan: true,
      });
    } else if (e.type === "span.model_request_start") {
      let end: Timed | undefined = id ? modelEndsById.get(id) : undefined;
      if (id && end) modelEndsById.delete(id);
      if (!end) end = takeAfter(modelEndsNoId, i);
      let ft: Timed | undefined = id ? firstTokById.get(id) : undefined;
      if (!ft) ft = takeAfter(firstTokNoId, i);
      if (ft) base.events.push(ft.e);
      const usage = end ? reportedUsage(field(end.e, "model_usage")) : undefined;
      const finishReason = end ? str(field(end.e, "finish_reason")) : undefined;
      const model = str(field(e, "model")) ?? (end ? str(field(end.e, "model")) : undefined);
      const isError = end ? field(end.e, "is_error") === true : false;
      const ttftMs = ft && ft.t !== null && t !== null ? Math.max(0, ft.t - t) : undefined;
      const tok = usage ? usageText(usage) : undefined;
      ranged({
        key: `model-${id ?? i}`,
        family: "model",
        kind: "model",
        label: model ? `Generation · ${model}` : "Generation",
        detail: [finishReason, ttftMs !== undefined ? `TTFT ${formatDuration(ttftMs)}` : undefined, tok].filter(Boolean).join(" · ") || undefined,
        model,
        usage,
        finishReason,
        ttftMs,
        isError,
        errorText: isError ? str(field(end!.e, "error_message")) ?? "model returned an error" : undefined,
      }, end);
    } else if (e.type === "span.compaction_summarize_start") {
      // FIFO: the first unclaimed summarize_end after this start.
      const end = takeAfter(compactEnds, i);
      const f = summarizeFields(e, end?.e);
      ranged({
        key: `compact-${i}`,
        family: "compaction",
        kind: "lifecycle",
        label: "compaction",
        detail: f.detail,
        model: f.model,
        usage: f.usage,
        finishReason: f.finishReason,
        isError: f.isError,
        errorText: f.isError ? "compaction summarize finish_reason: error" : undefined,
        compaction: { role: "summarize", ...(f.finalTextLength !== undefined ? { finalTextLength: f.finalTextLength } : {}) },
      }, end);
    } else if (e.type === "span.compaction_summarize_end") {
      // Still unclaimed when reached in stream order ⇒ no earlier start can
      // take it (starts only claim later ends). Surface it, never drop it.
      if (!compactEnds.some((x) => x.i === i)) continue;
      const f = summarizeFields(undefined, e);
      instant({
        key: `compact-end-${i}`,
        family: "compaction",
        kind: "lifecycle",
        label: "compaction end (no matching start)",
        detail: f.detail,
        model: f.model,
        usage: f.usage,
        finishReason: f.finishReason,
        isError: f.isError,
        errorText: f.isError ? "compaction summarize finish_reason: error" : undefined,
        orphan: true,
        compaction: { role: "orphan_end", ...(f.finalTextLength !== undefined ? { finalTextLength: f.finalTextLength } : {}) },
      });
    } else if (e.type === "span.outcome_evaluation_start") {
      const end = outcomeEnds[outcomeIdx++];
      const result = end ? str(field(end.e, "result")) : undefined;
      ranged({ key: `outcome-${i}`, family: "outcome", kind: "lifecycle", label: "outcome eval", detail: result, isError: result === "failed" }, end);
    } else if (
      e.type === "span.model_request_end" ||
      e.type === "span.model_first_token" ||
      e.type === "span.outcome_evaluation_end" ||
      e.type === "span.outcome_evaluation_ongoing"
    ) {
      continue; // paired or progress noise
    } else if (e.type === "span.wakeup_scheduled") {
      // In-turn schedule wait: scheduled → the wakeup user.message whose
      // parent_event_id is this span's id (mint-then-emit, see
      // session-do.ts:scheduleWakeup). Known wait, not between-turn idle.
      const fired = id ? childByParent.get(id) : undefined;
      ranged({ key: `sched-${id ?? i}`, family: "schedule", kind: "lifecycle", label: "schedule waiting", detail: fired ? "fired" : "pending" }, fired);
      // The fired user.message also stays its own (trigger) step.
    } else if (e.type === "user.message") {
      const md = (e as { metadata?: { harness?: string; kind?: string } }).metadata;
      const isWakeup = md?.harness === "schedule" && md?.kind === "wakeup";
      const queued = isQueuedSessionEvent(e);
      const text = eventText(e as Rec);
      instant({
        key: `u-${id ?? i}`,
        family: isWakeup ? "wakeup" : "user",
        kind: "user",
        label: [isWakeup ? "user.message (wakeup)" : "user.message", queued ? "· queued" : ""].filter(Boolean).join(" "),
        detail: oneLine(text) || undefined,
        text,
      });
    } else if (e.type === "user.tool_confirmation") {
      const result = str(field(e, "result"));
      instant({
        key: `confirm-${id ?? i}`,
        family: "custom_tool",
        kind: "lifecycle",
        label: "tool confirmation",
        detail: [result, str(field(e, "deny_message"))].filter(Boolean).join(" · ") || undefined,
        callId: str(e.tool_use_id),
      });
    } else if (e.type === "agent.message") {
      const text = eventText(e as Rec);
      instant({ key: `a-${id ?? i}`, family: "agent", kind: "assistant", label: "agent.message", detail: oneLine(text) || undefined, text });
    } else if (e.type === "agent.thinking") {
      const text = eventText(e as Rec);
      instant({ key: `think-${id ?? i}`, family: "thinking", kind: "thinking", label: "agent.thinking", detail: oneLine(text) || undefined, text });
    } else if (e.type === "aux.model_call") {
      instant({ key: `aux-${i}`, family: "aux", kind: "lifecycle", label: "aux.model_call" });
    } else if (THREAD_MARKERS.has(e.type)) {
      const name = str(field(e, "agent_name"));
      instant({
        key: `thread-${i}`,
        family: "thread",
        kind: "lifecycle",
        label: e.type.replace(/^.*\./, ""),
        detail: [name, str(field(e, "session_thread_id")), str(field(e, "to_thread_id")), str(field(e, "from_thread_id"))].filter(Boolean).join(" · ") || undefined,
      });
    } else if (e.type === "agent.thread_context_compacted") {
      const info = boundaryInfo(e);
      const counts = info.originalMessageCount !== undefined && info.compactedMessageCount !== undefined
        ? `${info.originalMessageCount} → ${info.compactedMessageCount} messages`
        : undefined;
      instant({
        key: `compact-marker-${i}`,
        family: "compaction",
        kind: "lifecycle",
        label: "thread compacted",
        detail: [counts, info.trigger, info.summary ? oneLine(info.summary, 80) : undefined].filter(Boolean).join(" · ") || undefined,
        text: info.summary,
        compaction: info,
      });
    } else if (e.type === "session.error") {
      const msg = typeof e.error === "string" ? e.error : eventText(e as Rec) || JSON.stringify(e.error ?? null);
      instant({ key: `err-${i}`, family: "error", kind: "error", label: "session.error", detail: oneLine(msg) || undefined, isError: true, errorText: msg });
    } else if (e.type === "session.warning") {
      // Includes the Pi assembly adapter's "oma.context_reassembled" marker:
      // a real warning with its own source — not a summarize span.
      instant({ key: `warn-${i}`, family: "warn", kind: "lifecycle", label: `warning:${String(e.source ?? "")}`, detail: String(e.message ?? "") || undefined });
    } else if (e.type === "session.outcome_evaluated") {
      const result = str(field(e, "result"));
      instant({ key: `outcome-r-${i}`, family: "outcome", kind: "lifecycle", label: "outcome evaluated", detail: [result, oneLine(eventText(e as Rec))].filter(Boolean).join(" — ") || undefined, isError: result === "failed" });
    } else if (e.type.startsWith("session.")) {
      const stop = (e.stop_reason as { type?: string } | undefined)?.type;
      instant({ key: `s-${i}`, family: "system", kind: "lifecycle", label: e.type, detail: stop ? `stop_reason: ${stop}` : undefined });
    } else {
      // Catch-all: surface unknown types as instant markers rather than
      // silently dropping them.
      instant({ key: `mk-${i}`, family: "marker", kind: "lifecycle", label: e.type });
    }
  }
  // Keys must be unique for React and selection even if an id repeats.
  const seen = new Map<string, number>();
  for (const st of steps) {
    const n = seen.get(st.key) ?? 0;
    seen.set(st.key, n + 1);
    if (n > 0) st.key = `${st.key}#${n}`;
  }
  return steps;
}

function parseEventTs(e: Event): number {
  return eventTsMs(e);
}

/**
 * Group a session's flat event stream into per-turn buckets, where a
 * "turn" starts on a user trigger event and ends on the next session
 * status_idle / .status_terminated / .error. Same definition the harness
 * uses internally (see drainEventQueue in session-do.ts).
 *
 * `isRootEvent` (default: every event) limits which events may open or
 * close a turn. When a stream mixes sub-agent thread events, the
 * sub-agent's own user.message / status_idle must not split the parent's
 * turn; those events still land in whichever turn is open.
 */
export function bucketIntoTurns(
  events: readonly Event[],
  isRootEvent: (e: Event) => boolean = () => true,
): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  // user.message metadata.harness === "schedule" + kind === "wakeup" is
  // the wire convention for cron-fired turns (see SessionDO.onScheduledWakeup).
  // Distinguish them in the trigger badge so an operator scanning the
  // timeline can tell at a glance "the agent woke itself" from "the user
  // sent something".
  const triggerKindOf = (e: Event): TurnTriggerKind | null => {
    if (e.type === "user.message") {
      const md = (e as { metadata?: { harness?: string; kind?: string } }).metadata;
      if (md?.harness === "schedule" && md?.kind === "wakeup") return "wakeup";
      return "user_message";
    }
    if (e.type === "user.tool_confirmation") return "tool_confirmation";
    if (e.type === "user.custom_tool_result") return "custom_tool_result";
    return null;
  };

  for (const e of events) {
    const root = isRootEvent(e);
    const k = root ? triggerKindOf(e) : null;
    if (k) {
      current = {
        id: `turn-${turns.length}`,
        triggerKind: k,
        trigger: e,
        triggerTs: parseEventTs(e),
        events: [e],
        status: "running",
        queued: isQueuedSessionEvent(e),
      };
      turns.push(current);
      continue;
    }
    if (!current) {
      // Pre-trigger init events (init_events injected by /init handler,
      // platform reminders, etc.) — bucket into a synthetic init turn so
      // they get a card rather than being silently dropped.
      current = {
        id: `turn-init`,
        triggerKind: "init",
        triggerTs: parseEventTs(e),
        events: [e],
        status: "running",
        queued: isQueuedSessionEvent(e),
      };
      turns.push(current);
      continue;
    }
    current.events.push(e);
    if (!root) continue;
    if (e.type === "session.status_idle") {
      current.status = "completed";
      current.endedAt = parseEventTs(e);
    } else if (e.type === "session.status_terminated") {
      current.status = "terminated";
      current.endedAt = parseEventTs(e);
    } else if (e.type === "session.error") {
      current.status = "errored";
      current.endedAt = parseEventTs(e);
    }
  }

  return turns;
}
