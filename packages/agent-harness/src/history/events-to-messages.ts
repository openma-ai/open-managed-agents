import type { ModelMessage, ToolModelMessage, AssistantModelMessage } from "ai";
import type {
  SessionEvent,
  AgentMessageEvent,
  AgentThinkingEvent,
  AgentToolUseEvent,
  AgentToolResultEvent,
  AgentMcpToolUseEvent,
  AgentMcpToolResultEvent,
  AgentCustomToolUseEvent,
  AgentThreadContextCompactedEvent,
  ContentBlock,
  UserMessageEvent,
} from "@open-managed-agents/shared";
import { normalizeInterruptedToolCalls } from "./interrupted-tool-calls";
import { pickPreservedTail, TAIL_MAX_TOKENS, TAIL_MIN_MESSAGES, TAIL_MIN_TOKENS } from "./preserved-tail";
import { userContentToParts, userContentToPartsAsync, type FileResolver, type ResolvedFile } from "./user-content-parts";

/**
 * Convert SessionEvent[] → ModelMessage[]. The strict inverse of
 * default-loop.ts onStepFinish writes — together they form the bijection
 * that prompt-cache determinism rests on.
 *
 * Invariant: write(read(events)) === events at the byte level for every
 * event sequence produced by onStepFinish (modulo lifecycle/span/notification
 * events, which are intentionally not in model context). Any byte drift here
 * busts Anthropic's cache from the drift point onward.
 *
 * Determinism rules:
 *   - Pre-pass once to build toolCallId → toolName, so tool-result events can
 *     resolve toolName even when the matching tool_use lies in a different
 *     "flush window" (the old `pendingToolCalls.find` failed on that case
 *     and produced "unknown" — a permanent cache miss).
 *   - Iterate events strictly by storage order (caller's job to sort by seq).
 *   - Honor the LAST agent.thread_context_compacted boundary that carries a
 *     `summary` payload: build pre-boundary and post-boundary messages
 *     separately, inject the summary, pick a CC-style tail of the
 *     pre-boundary messages by token budget, then output
 *     `[summary, ...tail, ...post-boundary]`. Boundary events without a
 *     summary are pure UI signals (no effect here).
 *   - Skip lifecycle.* / span.* / notification.* / agent.thread_message_*
 *     and bare (summary-less) compaction events.
 *
 * Sync API: file_id-source image/document blocks fall back to a placeholder
 * text part because resolution requires I/O. Callers that own the resolver
 * (default-loop) should use `eventsToMessagesAsync(events, resolver)` so
 * the model sees the actual file bytes; this sync entry point is kept for
 * tests, in-memory sub-agents, and anywhere a synchronous projection is
 * required.
 */
export function eventsToMessages(inputEvents: SessionEvent[]): ModelMessage[] {
  const events = normalizeInterruptedToolCalls(inputEvents);
  // Pre-pass: gather toolName for every toolCallId emitted by ANY tool_use
  // event. Resolves the cross-window lookup problem.
  const toolNameById = new Map<string, string>();
  for (const event of events) {
    if (
      event.type === "agent.tool_use" ||
      event.type === "agent.mcp_tool_use" ||
      event.type === "agent.custom_tool_use"
    ) {
      const e = event as AgentToolUseEvent | AgentMcpToolUseEvent | AgentCustomToolUseEvent;
      const name = event.type === "agent.mcp_tool_use"
        ? `mcp_${(e as AgentMcpToolUseEvent).mcp_server_name}_call`
        : (e as AgentToolUseEvent | AgentCustomToolUseEvent).name;
      toolNameById.set(e.id, name);
    }
  }

  // Find the last compaction boundary that actually carries a summary —
  // that's the one we honor. Earlier boundaries get superseded.
  //
  // "Carries a summary" means: at least one block contains real content.
  // A bare array-length check (`summary.length > 0`) is NOT sufficient —
  // a strategy that returns `[{type:"text", text:""}]` would still pass
  // it and silently drop the entire pre-boundary history downstream.
  // This is the downstream half of the empty-summary defense; the
  // upstream half lives in DefaultHarness.compact() where the boundary
  // event is written.
  let boundaryIdx = -1;
  let boundarySummary: ContentBlock[] | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "agent.thread_context_compacted") {
      const ce = e as AgentThreadContextCompactedEvent;
      const hasContent = ce.summary?.some(
        (b) => (b.type === "text" && b.text.trim().length > 0)
          || b.type === "image"
          || b.type === "document",
      );
      if (hasContent) {
        boundaryIdx = i;
        boundarySummary = ce.summary;
        break;
      }
    }
  }

  // No boundary → walk everything straight through.
  if (boundaryIdx < 0) {
    return buildMessages(events, 0, events.length, toolNameById);
  }

  // Boundary exists. Build pre/post separately; pick CC-style tail from pre.
  const preBoundary = buildMessages(events, 0, boundaryIdx, toolNameById);
  const postBoundary = buildMessages(events, boundaryIdx + 1, events.length, toolNameById);
  const tail = pickPreservedTail(preBoundary, {
    minTokens: TAIL_MIN_TOKENS,
    maxTokens: TAIL_MAX_TOKENS,
    minMessages: TAIL_MIN_MESSAGES,
  });

  // Inject the boundary summary as a synthesized user message that opens
  // the post-compaction view. Wrapped in <conversation-summary> tags so the
  // model recognizes it as platform-injected context.
  const summaryMessage: ModelMessage = {
    role: "user",
    content: [{ type: "text", text: serializeSummaryAsText(boundarySummary!) }],
  };

  return [summaryMessage, ...tail, ...postBoundary];
}

/**
 * Async counterpart to `eventsToMessages`. Same projection rules + boundary
 * handling; the only difference is that `user.message` content with an
 * image/document source of type `"file"` is resolved through `resolver`
 * (when supplied) so the model receives real bytes instead of a placeholder.
 *
 * Caching: a per-call `Map<file_id, Promise<ResolvedFile | null>>` dedupes
 * repeated references — the same file_id quoted across multiple turns of one
 * derive cycle only triggers one R2 fetch.
 *
 * Failure mode: `resolver` returns `null` for missing / inaccessible files;
 * we emit a `{ type: "text", text: "[image|document: file <id> unavailable]" }`
 * placeholder so the model gets context that something was there but the
 * turn doesn't crash.
 *
 * When `resolver` is undefined, the behavior collapses to the sync version
 * (file_id sources become placeholders). Kept that way so callers can opt in
 * without forcing every call site to wire a resolver.
 */
export async function eventsToMessagesAsync(
  events: SessionEvent[],
  resolver?: FileResolver,
): Promise<ModelMessage[]> {
  if (!resolver) return eventsToMessages(events);
  events = normalizeInterruptedToolCalls(events);

  // Pre-pass: gather toolName for every toolCallId emitted by ANY tool_use
  // event. Resolves the cross-window lookup problem.
  const toolNameById = new Map<string, string>();
  for (const event of events) {
    if (
      event.type === "agent.tool_use" ||
      event.type === "agent.mcp_tool_use" ||
      event.type === "agent.custom_tool_use"
    ) {
      const e = event as AgentToolUseEvent | AgentMcpToolUseEvent | AgentCustomToolUseEvent;
      const name = event.type === "agent.mcp_tool_use"
        ? `mcp_${(e as AgentMcpToolUseEvent).mcp_server_name}_call`
        : (e as AgentToolUseEvent | AgentCustomToolUseEvent).name;
      toolNameById.set(e.id, name);
    }
  }

  // Per-call resolver cache. Stores the in-flight promise so two
  // simultaneous references to the same file_id share a single fetch.
  // Promise-keyed (rather than result-keyed) so the dedup works even when
  // the second lookup races the first before resolution lands.
  const cache = new Map<string, Promise<ResolvedFile | null>>();
  const cachedResolve: FileResolver = (file_id) => {
    let p = cache.get(file_id);
    if (!p) {
      // Swallow resolver errors as null so a single failure can't break the
      // entire projection. The caller will see the placeholder and continue.
      p = resolver(file_id).catch(() => null);
      cache.set(file_id, p);
    }
    return p;
  };

  // Same boundary detection as the sync path — duplicated here because we
  // need to invoke async block builders downstream.
  let boundaryIdx = -1;
  let boundarySummary: ContentBlock[] | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "agent.thread_context_compacted") {
      const ce = e as AgentThreadContextCompactedEvent;
      const hasContent = ce.summary?.some(
        (b) => (b.type === "text" && b.text.trim().length > 0)
          || b.type === "image"
          || b.type === "document",
      );
      if (hasContent) {
        boundaryIdx = i;
        boundarySummary = ce.summary;
        break;
      }
    }
  }

  if (boundaryIdx < 0) {
    return buildMessagesAsync(events, 0, events.length, toolNameById, cachedResolve);
  }

  const preBoundary = await buildMessagesAsync(events, 0, boundaryIdx, toolNameById, cachedResolve);
  const postBoundary = await buildMessagesAsync(events, boundaryIdx + 1, events.length, toolNameById, cachedResolve);
  const tail = pickPreservedTail(preBoundary, {
    minTokens: TAIL_MIN_TOKENS,
    maxTokens: TAIL_MAX_TOKENS,
    minMessages: TAIL_MIN_MESSAGES,
  });

  const summaryMessage: ModelMessage = {
    role: "user",
    content: [{ type: "text", text: serializeSummaryAsText(boundarySummary!) }],
  };

  return [summaryMessage, ...tail, ...postBoundary];
}

/**
 * Walk events[fromIdx..toIdx) into ModelMessage[]. Maintains pending
 * assistant + tool state internally, flushes at the end. Used by
 * eventsToMessages on either the full stream, the pre-boundary range, or
 * the post-boundary range.
 */
function buildMessages(
  events: SessionEvent[],
  fromIdx: number,
  toIdx: number,
  toolNameById: Map<string, string>,
): ModelMessage[] {
  const messages: ModelMessage[] = [];
  let pendingAssistantContent: Exclude<AssistantModelMessage["content"], string> = [];
  let pendingToolContent: ToolModelMessage["content"] = [];

  const flushAssistant = () => {
    if (pendingAssistantContent.length > 0) {
      // DeepSeek Anthropic-compat (and strict Anthropic validators): any text
      // AFTER tool_use in the same assistant message makes the following
      // tool_result look unpaired ("tool_use ids were found without
      // tool_result blocks immediately after"). Keep tool-calls last —
      // same as @ai-sdk/anthropic moveToolUseBlocksToEnd.
      const toolCalls = pendingAssistantContent.filter((part) => part.type === "tool-call");
      const other = pendingAssistantContent.filter((part) => part.type !== "tool-call");
      messages.push({ role: "assistant", content: [...other, ...toolCalls] });
      pendingAssistantContent = [];
    }
  };
  const flushTools = () => {
    if (pendingToolContent.length > 0) {
      messages.push({ role: "tool", content: pendingToolContent });
      pendingToolContent = [];
    }
  };

  for (let i = fromIdx; i < toIdx; i++) {
    const event = events[i];
    // AMA `user.interrupt` flushes pending user inputs by setting
    // `cancelled_at` on their event-log row. Adapter (`getEvents` in
    // packages/event-log/src/cf-do/index.ts) stashes that as
    // `cancelled_at_ms` on the parsed event. Skip everything that's
    // been cancelled so the LLM context never sees a flushed input.
    // Only user.* events are ever cancelled today; the guard is
    // type-agnostic so future cancellation kinds (e.g. partial
    // assistant message rollback) inherit the same behavior.
    if ((event as unknown as { cancelled_at_ms?: number }).cancelled_at_ms != null) {
      continue;
    }
    // Queued turn inputs live in the same events table with processed_at
    // NULL (single-table queue). They are listed/replayed for the outbox,
    // but are not part of the model context until drain promotes them.
    if ((event as unknown as { _queued?: boolean })._queued === true) {
      continue;
    }
    switch (event.type) {
      case "user.message": {
        flushAssistant();
        flushTools();
        messages.push({
          role: "user",
          content: userContentToParts((event as UserMessageEvent).content),
        });
        break;
      }
      case "agent.thinking": {
        flushTools();
        const e = event as AgentThinkingEvent;
        if (e.text != null) {
          pendingAssistantContent.push({
            type: "reasoning",
            text: e.text,
            ...(e.providerOptions ? { providerOptions: e.providerOptions as Record<string, any> } : {}),
          });
        }
        break;
      }
      case "agent.message": {
        flushTools();
        const e = event as AgentMessageEvent;
        for (const block of e.content) {
          if (block.type === "text") {
            pendingAssistantContent.push({ type: "text", text: block.text });
          }
        }
        break;
      }
      case "agent.tool_use":
      case "agent.mcp_tool_use":
      case "agent.custom_tool_use": {
        flushTools();
        const e = event as AgentToolUseEvent | AgentMcpToolUseEvent | AgentCustomToolUseEvent;
        const toolName = event.type === "agent.mcp_tool_use"
          ? `mcp_${(e as AgentMcpToolUseEvent).mcp_server_name}_call`
          : (e as AgentToolUseEvent | AgentCustomToolUseEvent).name;
        pendingAssistantContent.push({
          type: "tool-call",
          toolCallId: e.id,
          toolName,
          input: e.input,
        });
        break;
      }
      case "agent.tool_result":
      case "agent.mcp_tool_result": {
        flushAssistant();
        const e = event as AgentToolResultEvent | AgentMcpToolResultEvent;
        const toolCallId = event.type === "agent.tool_result"
          ? (e as AgentToolResultEvent).tool_use_id
          : (e as AgentMcpToolResultEvent).mcp_tool_use_id;
        const toolName = toolNameById.get(toolCallId) ?? "unknown";
        const output = wireContentToToolOutput((e as AgentToolResultEvent).content);
        pendingToolContent.push({
          type: "tool-result",
          toolCallId,
          toolName,
          output: output as any,
        });
        break;
      }
    }
  }

  flushAssistant();
  flushTools();
  return messages;
}

/**
 * Async twin of `buildMessages`. Identical control flow; the only divergence
 * is that `user.message` blocks go through `userContentToPartsAsync` so
 * file_id sources resolve through the supplied `resolver` instead of
 * collapsing to a placeholder.
 */
async function buildMessagesAsync(
  events: SessionEvent[],
  fromIdx: number,
  toIdx: number,
  toolNameById: Map<string, string>,
  resolver: FileResolver,
): Promise<ModelMessage[]> {
  const messages: ModelMessage[] = [];
  let pendingAssistantContent: Exclude<AssistantModelMessage["content"], string> = [];
  let pendingToolContent: ToolModelMessage["content"] = [];

  const flushAssistant = () => {
    if (pendingAssistantContent.length > 0) {
      // DeepSeek Anthropic-compat (and strict Anthropic validators): any text
      // AFTER tool_use in the same assistant message makes the following
      // tool_result look unpaired ("tool_use ids were found without
      // tool_result blocks immediately after"). Keep tool-calls last —
      // same as @ai-sdk/anthropic moveToolUseBlocksToEnd.
      const toolCalls = pendingAssistantContent.filter((part) => part.type === "tool-call");
      const other = pendingAssistantContent.filter((part) => part.type !== "tool-call");
      messages.push({ role: "assistant", content: [...other, ...toolCalls] });
      pendingAssistantContent = [];
    }
  };
  const flushTools = () => {
    if (pendingToolContent.length > 0) {
      messages.push({ role: "tool", content: pendingToolContent });
      pendingToolContent = [];
    }
  };

  for (let i = fromIdx; i < toIdx; i++) {
    const event = events[i];
    if ((event as unknown as { cancelled_at_ms?: number }).cancelled_at_ms != null) {
      continue;
    }
    // Queued turn inputs live in the same events table with processed_at
    // NULL (single-table queue). They are listed/replayed for the outbox,
    // but are not part of the model context until drain promotes them.
    if ((event as unknown as { _queued?: boolean })._queued === true) {
      continue;
    }
    switch (event.type) {
      case "user.message": {
        flushAssistant();
        flushTools();
        messages.push({
          role: "user",
          content: await userContentToPartsAsync((event as UserMessageEvent).content, resolver),
        });
        break;
      }
      case "agent.thinking": {
        flushTools();
        const e = event as AgentThinkingEvent;
        if (e.text != null) {
          pendingAssistantContent.push({
            type: "reasoning",
            text: e.text,
            ...(e.providerOptions ? { providerOptions: e.providerOptions as Record<string, any> } : {}),
          });
        }
        break;
      }
      case "agent.message": {
        flushTools();
        const e = event as AgentMessageEvent;
        for (const block of e.content) {
          if (block.type === "text") {
            pendingAssistantContent.push({ type: "text", text: block.text });
          }
        }
        break;
      }
      case "agent.tool_use":
      case "agent.mcp_tool_use":
      case "agent.custom_tool_use": {
        flushTools();
        const e = event as AgentToolUseEvent | AgentMcpToolUseEvent | AgentCustomToolUseEvent;
        const toolName = event.type === "agent.mcp_tool_use"
          ? `mcp_${(e as AgentMcpToolUseEvent).mcp_server_name}_call`
          : (e as AgentToolUseEvent | AgentCustomToolUseEvent).name;
        pendingAssistantContent.push({
          type: "tool-call",
          toolCallId: e.id,
          toolName,
          input: e.input,
        });
        break;
      }
      case "agent.tool_result":
      case "agent.mcp_tool_result": {
        flushAssistant();
        const e = event as AgentToolResultEvent | AgentMcpToolResultEvent;
        const toolCallId = event.type === "agent.tool_result"
          ? (e as AgentToolResultEvent).tool_use_id
          : (e as AgentMcpToolResultEvent).mcp_tool_use_id;
        const toolName = toolNameById.get(toolCallId) ?? "unknown";
        const output = wireContentToToolOutput((e as AgentToolResultEvent).content);
        pendingToolContent.push({
          type: "tool-result",
          toolCallId,
          toolName,
          output: output as any,
        });
        break;
      }
    }
  }

  flushAssistant();
  flushTools();
  return messages;
}

/**
 * Wire `string | ContentBlock[]` → AI SDK ToolResultOutput.
 * Strict inverse of normalizeToolOutputForWire in default-loop.ts.
 */
function wireContentToToolOutput(
  content: string | ContentBlock[],
): { type: "text"; value: string } | { type: "content"; value: any[] } {
  if (typeof content === "string") {
    return { type: "text", value: content };
  }
  return {
    type: "content",
    value: content.map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "image" && b.source.type === "base64") {
        return { type: "image-data", data: b.source.data ?? "", mediaType: b.source.media_type ?? "image/png" };
      }
      if (b.type === "image" && b.source.type === "url") {
        return { type: "image-url", url: b.source.url ?? "", mediaType: b.source.media_type };
      }
      if (b.type === "document" && b.source.type === "base64") {
        return { type: "file-data", data: b.source.data ?? "", mediaType: b.source.media_type ?? "application/pdf" };
      }
      if (b.type === "document" && b.source.type === "url") {
        return { type: "file-url", url: b.source.url ?? "", mediaType: b.source.media_type };
      }
      return { type: "text", text: JSON.stringify(b) };
    }),
  };
}

/**
 * Render boundary summary as a single text block with a structural marker.
 * The model recognizes <conversation-summary> from training data; we tag
 * the marker so it knows the preceding history is no longer in its window.
 *
 * Determinism: this serialization MUST be a pure function of `summary` —
 * no timestamps, no IDs, no key reordering. The summary itself is stored
 * verbatim in the boundary event, so its bytes are stable across turns.
 */
function serializeSummaryAsText(summary: ContentBlock[]): string {
  const parts: string[] = ["<conversation-summary>"];
  for (const block of summary) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push("[image elided]");
    else if (block.type === "document") parts.push(block.title ? `[document: ${block.title}]` : "[document]");
  }
  parts.push("</conversation-summary>");
  return parts.join("\n");
}
