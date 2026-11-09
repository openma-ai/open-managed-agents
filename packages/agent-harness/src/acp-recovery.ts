import { isRuntimeHistoryEventVisible } from "@open-managed-agents/session-runtime-contract/history";
import { SummarizeCompactionStrategy } from "./compaction";
import type { HarnessContext } from "./interface";
import type {
  ContentBlock,
  SessionEvent,
  UserMessageEvent,
} from "@open-managed-agents/shared";

export type AcpSemanticRecoveryReason = "native-state-missing" | "resume-unsupported" | "checkpoint-unavailable" | "execution-lost";

export interface AcpSemanticRecoveryOptions {
  reason: AcpSemanticRecoveryReason;
  /** Threshold for compaction; never authorizes dropping characters. */
  maxCharacters?: number;
}

const DEFAULT_MAX_CHARACTERS = 32_000;

/**
 * Project the canonical Managed Agents event log into one ACP user turn.
 *
 * This is deliberately semantic rather than a native-format conversion:
 * completed tool inputs are never copied into the prompt, so restoring a
 * missing private session cannot accidentally replay an old side effect.
 */
export function buildAcpSemanticRecoveryPrompt(
  events: readonly SessionEvent[],
  currentMessage: UserMessageEvent,
  options: AcpSemanticRecoveryOptions,
): string {
  const currentText = contentToText(currentMessage.content).trim();
  const relevantEvents = withoutCurrentMessage(
    eventsAfterLastCompaction(events.filter(isRuntimeHistoryEventVisible)),
    currentMessage,
  );
  const toolNames = collectToolNames(relevantEvents);
  const lines = relevantEvents.flatMap((event) =>
    eventToRecoveryLines(event, toolNames)
  );

  const prefix = [
    `<openma-recovery version="1" reason="${options.reason}">`,
    "The previous agent-native session state is unavailable.",
    "Continue from the canonical OpenMA history and the current workspace.",
    "Do not repeat completed side effects. Inspect current files before changing them.",
    "Recovered conversation:",
  ].join("\n");
  const currentLabel = "Current request:";
  const closingTag = "</openma-recovery>";
  const boundedCurrent = currentText;
  const history = lines.join("\n");
  return [
    prefix,
    history,
    currentLabel,
    boundedCurrent,
    closingTag,
  ].join("\n");
}

/** Single rebuild implementation shared with execution-loss recovery. Never replays tool inputs. */
export async function rebuildAcpContext(ctx: HarnessContext, reason: AcpSemanticRecoveryReason): Promise<{ prompt: string; compacted: boolean; historyCharacters: number; exceedsLimit: boolean }> {
  const events = withoutCurrentMessage((ctx.acpRecoveryHistory ?? ctx.runtime.history.getEvents()).filter(isRuntimeHistoryEventVisible), ctx.userMessage);
  const prompt = buildAcpSemanticRecoveryPrompt(events, ctx.userMessage, { reason });
  if (!eventsAfterLastCompaction(events).some(event => eventToRecoveryLines(event, new Map()).length > 0)) {
    throw new Error("ACP context could not be rebuilt: canonical history contains no usable conversation");
  }
  if (prompt.length <= DEFAULT_MAX_CHARACTERS) return { prompt, compacted: false, historyCharacters: prompt.length, exceedsLimit: false };
  // Use the existing summarize strategy rather than a last-N-characters window.
  const result = await new SummarizeCompactionStrategy().compact(events, {
    model: ctx.model, contextWindowTokens: 128_000, systemPrompt: ctx.systemPrompt,
    tools: ctx.tools, runtime: ctx.runtime,
    applyCacheStrategy: (system, tools, messages) => ({ system, tools, messages }),
  }).catch(() => null);
  if (result?.summary.some(block => block.type === "text" && block.text.trim())) {
    const boundary = { type: "agent.thread_context_compacted" as const, ...result };
    ctx.runtime.broadcast(boundary);
    return { prompt: buildAcpSemanticRecoveryPrompt([boundary], ctx.userMessage, { reason }), compacted: true, historyCharacters: prompt.length, exceedsLimit: true };
  }
  // A failed/empty compaction must not destroy usable context. Send it intact;
  // the provider may reject an oversized prompt, but it never becomes blank.
  return { prompt, compacted: false, historyCharacters: prompt.length, exceedsLimit: true };
}

function eventsAfterLastCompaction(
  events: readonly SessionEvent[],
): SessionEvent[] {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "agent.thread_context_compacted") continue;
    const summary = contentToText(event.summary ?? []).trim();
    if (!summary) continue;
    return [
      {
        type: "user.message",
        content: [{
          type: "text",
          text: `<conversation-summary>\n${summary}\n</conversation-summary>`,
        }],
      },
      ...events.slice(index + 1),
    ];
  }
  return [...events];
}

function withoutCurrentMessage(
  events: readonly SessionEvent[],
  currentMessage: UserMessageEvent,
): SessionEvent[] {
  // SessionDO normally persists the current event before entering the
  // harness. Match by object identity or durable event id, never by text: two
  // consecutive user turns are allowed to contain exactly the same bytes.
  let currentIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event === currentMessage ||
      (currentMessage.id !== undefined &&
        event.type === "user.message" &&
        event.id === currentMessage.id)
    ) {
      currentIndex = index;
      break;
    }
  }
  return currentIndex < 0
    ? [...events]
    : events.filter((_, index) => index !== currentIndex);
}

function collectToolNames(events: readonly SessionEvent[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const event of events) {
    if (event.type === "agent.tool_use" || event.type === "agent.custom_tool_use") {
      names.set(event.id, event.name);
    } else if (event.type === "agent.mcp_tool_use") {
      names.set(event.id, `${event.mcp_server_name}/${event.name}`);
    }
  }
  return names;
}

function eventToRecoveryLines(
  event: SessionEvent,
  toolNames: ReadonlyMap<string, string>,
): string[] {
  switch (event.type) {
    case "user.message": {
      const text = contentToText(event.content).trim();
      return text ? [`User: ${text}`] : [];
    }
    case "agent.message": {
      const text = contentToText(event.content).trim();
      return text ? [`Assistant: ${text}`] : [];
    }
    case "agent.tool_result": {
      const result = typeof event.content === "string"
        ? event.content
        : contentToText(event.content);
      return result.trim()
        ? [`Completed tool ${toolNames.get(event.tool_use_id) ?? "unknown"}: ${result.trim()}`]
        : [];
    }
    case "agent.mcp_tool_result": {
      const result = typeof event.content === "string"
        ? event.content
        : contentToText(event.content);
      return result.trim()
        ? [
            `${event.is_error ? "Failed" : "Completed"} tool ${
              toolNames.get(event.mcp_tool_use_id) ?? "unknown"
            }: ${result.trim()}`,
          ]
        : [];
    }
    case "user.custom_tool_result": {
      const result = contentToText(event.content).trim();
      return result
        ? [`Completed tool ${toolNames.get(event.custom_tool_use_id) ?? "unknown"}: ${result}`]
        : [];
    }
    default:
      return [];
  }
}

function contentToText(content: readonly ContentBlock[]): string {
  return content.map((block) => {
    if (block.type === "text") return block.text;
    const reference = block.source.file_id ?? block.source.url;
    const label = block.type === "document" && block.title
      ? `${block.type} ${block.title}`
      : block.type;
    return reference ? `[${label}: ${reference}]` : `[${label}]`;
  }).filter(Boolean).join("\n");
}

// Oversized history is handled by rebuildAcpContext, never sliced here.
