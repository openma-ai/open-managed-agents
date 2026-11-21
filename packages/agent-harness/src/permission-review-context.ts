import type { SessionEvent } from "@open-managed-agents/shared";

/**
 * Limits for the transcript sent to an automatic permission reviewer.
 *
 * These are character budgets rather than token budgets because the reviewer
 * receives a data transcript, not a model-context message list. They keep a
 * large tool result from crowding the authorization facts out of the prompt.
 */
export const PERMISSION_REVIEW_CONTEXT_LIMITS = {
  maxEntries: 64,
  maxEntryChars: 4_000,
  maxChars: 24_000,
} as const;

export interface PermissionReviewContextOptions {
  maxEntries?: number;
  maxEntryChars?: number;
  maxChars?: number;
}

type ReviewEvent = {
  index: number;
  type: string;
  value: Record<string, unknown>;
};

/**
 * Build the bounded, review-specific transcript used by the auto permission
 * judge. This is a projection of the parent event log; it never mutates or
 * compacts the parent conversation.
 *
 * The projection intentionally keeps the authorization evidence a reviewer
 * needs (conversation, tool calls/results, confirmations, warnings, and
 * compaction summaries) while dropping transport and telemetry noise.
 */
export function buildPermissionReviewTranscript(
  events: readonly SessionEvent[] | undefined,
  options: PermissionReviewContextOptions = {},
): string {
  if (!events || events.length === 0) return "(none)";

  const limits = {
    maxEntries: positiveLimit(options.maxEntries, PERMISSION_REVIEW_CONTEXT_LIMITS.maxEntries),
    maxEntryChars: positiveLimit(options.maxEntryChars, PERMISSION_REVIEW_CONTEXT_LIMITS.maxEntryChars),
    maxChars: positiveLimit(options.maxChars, PERMISSION_REVIEW_CONTEXT_LIMITS.maxChars),
  };

  const boundary = latestCompactionBoundary(events);
  const reviewEvents: ReviewEvent[] = [];
  for (let index = boundary; index < events.length; index += 1) {
    const projected = projectReviewEvent(events[index], index);
    if (projected) reviewEvents.push(projected);
  }
  if (reviewEvents.length === 0) return "(none)";

  const entries = reviewEvents.map((event) => ({
    ...event,
    text: truncate(JSON.stringify(event.value), limits.maxEntryChars),
  }));
  const selected = selectBoundedEntries(entries, limits);
  const omitted = entries.length - selected.length;
  const lines = selected.map((entry) => entry.text);
  if (omitted > 0) {
    lines.unshift(`[${omitted} review entr${omitted === 1 ? "y" : "ies"} omitted by the context budget]`);
  }
  return lines.join("\n");
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

function latestCompactionBoundary(events: readonly SessionEvent[]): number {
  let boundary = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (
      event.type === "agent.thread_context_compacted" &&
      Array.isArray(event.summary) &&
      event.summary.length > 0
    ) {
      // The persisted summary replaces the history before this event. Keep
      // the summary itself and the events that followed it.
      boundary = index;
    }
  }
  return boundary;
}

function projectReviewEvent(event: SessionEvent, index: number): ReviewEvent | null {
  switch (event.type) {
    case "user.message":
      return { index, type: event.type, value: { type: event.type, content: reviewContent(event.content) } };
    case "agent.message":
      return { index, type: event.type, value: { type: event.type, content: reviewContent(event.content) } };
    case "agent.tool_use":
      return {
        index,
        type: event.type,
        value: { type: event.type, id: event.id, name: event.name, input: event.input, evaluated_permission: event.evaluated_permission },
      };
    case "agent.tool_result":
      return {
        index,
        type: event.type,
        value: { type: event.type, tool_use_id: event.tool_use_id, content: reviewContent(event.content), is_error: event.is_error },
      };
    case "agent.mcp_tool_use":
      return {
        index,
        type: event.type,
        value: {
          type: event.type,
          id: event.id,
          mcp_server_name: event.mcp_server_name,
          name: event.name,
          input: event.input,
          evaluated_permission: event.evaluated_permission,
        },
      };
    case "agent.mcp_tool_result":
      return {
        index,
        type: event.type,
        value: { type: event.type, mcp_tool_use_id: event.mcp_tool_use_id, content: reviewContent(event.content), is_error: event.is_error },
      };
    case "agent.custom_tool_use":
      return { index, type: event.type, value: { type: event.type, id: event.id, name: event.name, input: event.input } };
    case "user.tool_confirmation":
      return {
        index,
        type: event.type,
        value: { type: event.type, tool_use_id: event.tool_use_id, result: event.result, deny_message: event.deny_message },
      };
    case "user.custom_tool_result":
      return {
        index,
        type: event.type,
        value: { type: event.type, custom_tool_use_id: event.custom_tool_use_id, content: reviewContent(event.content), is_error: event.is_error },
      };
    case "user.define_outcome":
      return {
        index,
        type: event.type,
        value: { type: event.type, description: event.description, rubric: event.rubric, verifier: event.verifier },
      };
    case "agent.thread_message":
      return { index, type: event.type, value: { type: event.type, content: reviewContent(event.content) } };
    case "agent.thread_message_sent":
      return {
        index,
        type: event.type,
        value: { type: event.type, to_session_thread_id: event.to_session_thread_id, to_agent_name: event.to_agent_name, content: reviewContent(event.content) },
      };
    case "agent.thread_message_received":
      return {
        index,
        type: event.type,
        value: { type: event.type, from_session_thread_id: event.from_session_thread_id, from_agent_name: event.from_agent_name, content: reviewContent(event.content) },
      };
    case "agent.thread_context_compacted":
      if (!Array.isArray(event.summary) || event.summary.length === 0) return null;
      return {
        index,
        type: event.type,
        value: {
          type: event.type,
          summary: reviewContent(event.summary),
          original_message_count: event.original_message_count,
          compacted_message_count: event.compacted_message_count,
        },
      };
    case "session.warning":
      return { index, type: event.type, value: { type: event.type, source: event.source, message: event.message, details: event.details } };
    case "session.error":
      return { index, type: event.type, value: { type: event.type, error: event.error } };
    default:
      return null;
  }
}

function reviewContent(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((part) => {
    if (!part || typeof part !== "object") return part;
    const block = part as Record<string, unknown>;
    if (block.type === "text") return { type: "text", text: typeof block.text === "string" ? block.text : "" };
    if (block.type === "image" || block.type === "file") {
      return {
        type: block.type,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
        data: "[binary content omitted from permission review]",
      };
    }
    return { type: typeof block.type === "string" ? block.type : "unknown", text: typeof block.text === "string" ? block.text : undefined };
  });
}

function selectBoundedEntries(
  entries: Array<ReviewEvent & { text: string }>,
  limits: { maxEntries: number; maxChars: number },
): Array<ReviewEvent & { text: string }> {
  const selected = new Map<number, ReviewEvent & { text: string }>();
  const firstUserMessage = entries.find((entry) => entry.type === "user.message");
  if (firstUserMessage) {
    // Reserve part of the budget for the initiating instruction without
    // allowing one unusually large message to evict the latest tool evidence.
    const instructionBudget = Math.max(1, Math.floor(limits.maxChars / 3));
    selected.set(firstUserMessage.index, {
      ...firstUserMessage,
      text: truncate(firstUserMessage.text, instructionBudget),
    });
  }

  let chars = selectedChars(selected);
  for (let position = entries.length - 1; position >= 0; position -= 1) {
    const entry = entries[position];
    if (selected.has(entry.index)) continue;
    if (selected.size >= limits.maxEntries) break;
    const separator = selected.size > 0 ? 1 : 0;
    const available = limits.maxChars - chars - separator;
    if (available <= 0) break;
    if (entry.text.length > available) {
      // The newest evidence wins the remaining budget. Keep a bounded prefix
      // instead of dropping the event and accidentally reviewing only stale
      // instructions.
      selected.set(entry.index, { ...entry, text: truncate(entry.text, available) });
      break;
    }
    selected.set(entry.index, entry);
    chars += separator + entry.text.length;
  }

  return [...selected.values()].sort((a, b) => a.index - b.index);
}

function selectedChars(selected: Map<number, { text: string }>): number {
  return [...selected.values()].reduce((total, entry) => total + entry.text.length, 0) + Math.max(0, selected.size - 1);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return "…".slice(0, maxChars);
  return `${value.slice(0, maxChars - 1)}…`;
}
