import type { ModelMessage } from "ai";

// Tail preservation params (Claude Code-style defaults — observed values
// that work well for multi-turn coding sessions):
//   minTokens: 10_000  maxTokens: 40_000  minTextMessages: 5
export const TAIL_MIN_TOKENS = 10_000;
export const TAIL_MAX_TOKENS = 40_000;
export const TAIL_MIN_MESSAGES = 5;
// Industry-standard heuristic: image blocks bill at a flat ~2K tokens each.
const IMAGE_TOKEN_SIZE = 2_000;

/**
 * Per-content-part token estimate. Text uses length/4; image/file blocks
 * use a flat 2K; tool-use counts name + JSON input but not the id;
 * reasoning counts the text but not the signature.
 */
function estimateContentPartTokens(part: unknown): number {
  if (typeof part === "string") return Math.round(part.length / 4);
  if (!part || typeof part !== "object") return 0;
  const p = part as { type?: string; [k: string]: unknown };
  switch (p.type) {
    case "text":
      return Math.round(((p.text as string) ?? "").length / 4);
    case "reasoning":
      // Count thinking text only; signature is metadata, not tokenized.
      return Math.round(((p.text as string) ?? "").length / 4);
    case "tool-call":
      return Math.round((((p.toolName as string) ?? "") + JSON.stringify(p.input ?? {})).length / 4);
    case "tool-result":
      return estimateToolResultTokens(p.output);
    case "image":
    case "file":
      return IMAGE_TOKEN_SIZE;
    default:
      return Math.round(JSON.stringify(part).length / 4);
  }
}

function estimateToolResultTokens(output: unknown): number {
  if (!output || typeof output !== "object") return 0;
  const o = output as { type?: string; value?: unknown };
  if (o.type === "text") return Math.round((((o.value as string) ?? "")).length / 4);
  if (o.type === "content" && Array.isArray(o.value)) {
    let sum = 0;
    for (const item of o.value) {
      if (item && typeof item === "object") {
        const it = item as { type?: string; text?: string };
        if (it.type === "text") sum += Math.round((it.text ?? "").length / 4);
        else if (it.type === "image-data" || it.type === "image-url" || it.type === "file-data" || it.type === "file-url") sum += IMAGE_TOKEN_SIZE;
        else sum += Math.round(JSON.stringify(item).length / 4);
      }
    }
    return sum;
  }
  return Math.round(JSON.stringify(output).length / 4);
}

/**
 * Per-message estimate. Final result is padded by 4/3 to be conservative,
 * matching the heuristic Claude Code uses so our tail-picking budget aligns
 * with what users have come to expect from CC sessions.
 */
function estimateMessageTokensCC(m: ModelMessage): number {
  let total = 0;
  if (typeof m.content === "string") {
    total = Math.round(m.content.length / 4);
  } else if (Array.isArray(m.content)) {
    for (const part of m.content) total += estimateContentPartTokens(part);
  }
  return Math.ceil((total * 4) / 3);
}

/**
 * Walk messages backward, accumulating tokens, picking the largest tail
 * that satisfies (min tokens AND min text-block messages, capped at max
 * tokens). Tail must START on a user message — otherwise we'd send orphan
 * assistant/tool messages without their preceding user turn.
 */
export function pickPreservedTail(
  messages: ModelMessage[],
  opts: { minTokens: number; maxTokens: number; minMessages: number },
): ModelMessage[] {
  let tokens = 0;
  let textMsgs = 0;
  let tailStart = messages.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateMessageTokensCC(messages[i]);
    // Hard cap: don't grow past max once we've selected at least one msg.
    if (tailStart < messages.length && tokens + t > opts.maxTokens) break;

    tokens += t;
    if (messages[i].role === "user" || messages[i].role === "assistant") textMsgs++;
    tailStart = i;

    // Both minimums met AND we're on a user message → stop here so the tail
    // starts cleanly on a user turn.
    if (tokens >= opts.minTokens && textMsgs >= opts.minMessages && messages[i].role === "user") {
      break;
    }
  }

  // Final alignment: tail must START at a user message; walk forward to
  // the next user message if we landed on something else.
  while (tailStart < messages.length && messages[tailStart].role !== "user") tailStart++;

  return messages.slice(tailStart);
}
