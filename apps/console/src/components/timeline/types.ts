import type { Event } from "../../lib/events";

/** Keep time-axis tick DOM nodes bounded regardless of session duration. */
export const MAX_TICKS = 48;
/** Hard cap on the overview chart width in "auto" density (same budget the
 *  original per-turn waterfall used). Auto density based on median event
 *  gaps can otherwise produce hundreds of thousands of CSS pixels for a
 *  long schedule wait or idle gap. */
export const MAX_CHART_PX = 4_000;
/** Manual zoom (+, brush, fit selection) may go further than auto. */
export const MAX_MANUAL_CHART_PX = 64_000;
/** Overview step lanes. Steps that overlap beyond this share the last lane. */
export const MAX_OVERVIEW_LANES = 6;
/** Display width of a collapsed idle gap, as a fraction of the uncollapsed span. */
export const COLLAPSED_GAP_FRACTION = 0.03;

export type ModelUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/**
 * Fields reported by compaction events. Every field is optional and is set
 * only when the source event carries it — nothing here is estimated.
 *   - summarize span (span.compaction_summarize_end): finalTextLength
 *     (model / usage / finish_reason live on the step itself);
 *   - boundary (agent.thread_context_compacted): summary, counts, trigger,
 *     preTokens, replacedRange.
 */
export interface CompactionInfo {
  /** "summarize" span, "boundary" marker, or summarize end with no start. */
  role: "summarize" | "boundary" | "orphan_end";
  summary?: string;
  originalMessageCount?: number;
  compactedMessageCount?: number;
  trigger?: string;
  preTokens?: number;
  replacedRange?: { startSeq: number; endSeq: number };
  finalTextLength?: number;
}

/** Filter / semantic bucket of a trace step. */
export type TraceStepKind =
  | "user"
  | "assistant"
  | "thinking"
  | "model"
  | "tool"
  | "error"
  | "lifecycle";

export type ToolSource = "builtin" | "mcp" | "custom";

/**
 * One leaf in the Trace tree: a model call, tool call, schedule wait,
 * message, lifecycle marker, … Paired events (start + end, call + result)
 * collapse into one step. Times are absolute epoch ms and stay `null`
 * when the source events don't carry them — never 0, never guessed.
 */
export interface TraceStep {
  key: string;
  family: SpanFamily;
  kind: TraceStepKind;
  label: string;
  /** One-line summary (tool input, message text, finish reason, …). */
  detail?: string;
  startTs: number | null;
  /** null while pending, for instants, or when the end event has no time. */
  endTs: number | null;
  /** 0 for instants; null when unknown (pending or missing timestamps). */
  durationMs: number | null;
  instant: boolean;
  isError: boolean;
  /** Paired kind whose end/result never arrived. */
  pending: boolean;
  /** Result whose call is not in the stream. */
  orphan: boolean;
  toolName?: string;
  toolSource?: ToolSource;
  mcpServer?: string;
  callId?: string;
  input?: unknown;
  output?: string;
  /** Full message / thinking text. */
  text?: string;
  errorText?: string;
  model?: string;
  /** Only what span.model_request_end reported; never estimated. */
  usage?: ModelUsage;
  finishReason?: string;
  ttftMs?: number;
  /** Compaction telemetry, copied only from fields present on the
   *  span.compaction_summarize_end / agent.thread_context_compacted event. */
  compaction?: CompactionInfo;
  /** Raw session_thread_id of the first source event, when present. */
  threadId?: string;
  parentEventId?: string;
  /** Position of the first source event in the stream. */
  order: number;
  events: Event[];
}

export type SpanFamily =
  | "model"
  | "tool"
  | "mcp"
  | "custom_tool"
  | "user"
  | "agent"
  | "system"
  | "warn"
  | "error"
  | "schedule"     // schedule tool's "waiting for alarm" window (10s, 1h, …)
  | "wakeup"       // user.message synthesized by onScheduledWakeup
  | "compaction"   // span.compaction_summarize_*
  | "outcome"      // span.outcome_evaluation_*
  | "thread"       // sub-agent thread lifecycle / messages
  | "aux"          // aux.model_call (web_fetch summarizer etc.)
  | "thinking"     // agent.thinking marker
  | "marker";      // catch-all for unrecognized event types

/** Generation is violet and turns/agents are blue, matching the OpenAI
 *  Agents trace palette; MCP moves to the brand coral so it stays
 *  distinguishable from both. */
export const FAMILY_DOT: Record<SpanFamily, string> = {
  model: "bg-accent-violet",
  tool: "bg-success",
  mcp: "bg-brand",
  custom_tool: "bg-warning",
  user: "bg-fg-muted",
  agent: "bg-fg-muted",
  system: "bg-fg-subtle",
  warn: "bg-warning",
  error: "bg-danger",
  schedule: "bg-info",
  wakeup: "bg-info",
  compaction: "bg-trace-compaction",
  outcome: "bg-success/70",
  thread: "bg-fg-muted",
  aux: "bg-fg-subtle",
  thinking: "bg-fg-subtle",
  marker: "bg-fg-subtle",
};

export const FAMILY_BAR: Record<SpanFamily, string> = {
  model: "bg-accent-violet/70",
  tool: "bg-success/70",
  mcp: "bg-brand/70",
  custom_tool: "bg-warning/70",
  user: "bg-fg-muted/70",
  agent: "bg-fg-muted/70",
  system: "bg-fg-subtle/70",
  warn: "bg-warning/70",
  error: "bg-danger/70",
  schedule: "bg-info/40",
  wakeup: "bg-info/70",
  compaction: "bg-trace-compaction/75",
  outcome: "bg-success/50",
  thread: "bg-fg-muted/50",
  aux: "bg-fg-subtle/70",
  thinking: "bg-fg-subtle/40",
  marker: "bg-fg-subtle/40",
};

/**
 * A "turn" is the unit of agent work between a user trigger event
 * (user.message / user.tool_confirmation / user.custom_tool_result) and
 * the next session.status_idle / .status_terminated / .error. This is the
 * same definition the harness uses internally (see drainEventQueue in
 * apps/agent/src/runtime/session-do.ts) and matches Conversation view's
 * notion of a turn — so a Timeline burst card lines up 1:1 with a chat
 * exchange.
 */
export type TurnTriggerKind =
  | "user_message"
  | "wakeup"
  | "tool_confirmation"
  | "custom_tool_result"
  | "init";

export type TurnStatus = "completed" | "running" | "errored" | "terminated";

export interface Turn {
  id: string;
  triggerKind: TurnTriggerKind;
  trigger?: Event;
  /** Wall-clock ms epoch of the trigger (or first event for init turn). */
  triggerTs: number;
  /** Inclusive: trigger event + everything until the closing status event. */
  events: Event[];
  status: TurnStatus;
  /** True while the trigger user event is still queued under the official
   *  OpenMA delivery / turn.queued contract. Recomputed from the updated event
   *  in place, so the badge disappears when the same id becomes processed. */
  queued?: boolean;
  /** Wall-clock ms epoch when the turn closed; undefined while still running. */
  endedAt?: number;
}

export const TRIGGER_LABEL: Record<TurnTriggerKind, string> = {
  user_message: "user message",
  wakeup: "scheduled wakeup",
  tool_confirmation: "tool confirmation",
  custom_tool_result: "custom tool result",
  init: "session init",
};

export const TRIGGER_DOT: Record<TurnTriggerKind, string> = {
  user_message: "bg-brand",
  wakeup: "bg-info",
  tool_confirmation: "bg-warning",
  custom_tool_result: "bg-warning",
  init: "bg-fg-subtle",
};

export const STATUS_TEXT: Record<TurnStatus, string> = {
  completed: "text-fg-subtle",
  running: "text-info",
  errored: "text-danger",
  terminated: "text-danger",
};
