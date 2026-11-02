// Automatic Feishu reply egress.
//
// The Feishu ingest path (WS runner → FeishuProvider.dispatchEvent) only pushes
// inbound messages INTO a harness session — nothing mirrors the agent's reply
// back to Feishu. The original design assumed the agent would call the
// `mcp__feishu__*` send tools itself, but a plain-text-replying model never
// does, so users see silence. This writer closes that loop: it subscribes to
// the session's persisted events via the EventStreamHub and, on the FIRST
// `agent.message`, POSTs the reply text back into the originating chat.
//
// Why EventWriter / EventStreamHub and not a Container callback: the hub is
// the single in-process fan-out surface for assistant output and is already in
// scope at WS-runner boot time. Attaching a writer here is additive — no
// SessionCreator/Container interface change, no new dependency on the harness.
//
// One-shot + bounded: a writer attaches per inbound message, sends exactly
// once, then closes (detaching from the hub). A timeout closes it even if no
// reply arrives, so writers never leak on a stalled/erroring turn. Send
// failures are logged and swallowed — a Feishu API hiccup must never crash the
// inbound handler or block the harness turn.

import { getLogger } from "@open-managed-agents/observability";
import type { FeishuApiClient } from "@open-managed-agents/feishu";

import type { EventWriter } from "./event-stream-hub";

const log = getLogger("feishu-egress");

export interface FeishuEgressWriterOptions {
  /** Authenticated per-App client (caller caches one per appId). */
  client: FeishuApiClient;
  /**
   * The inbound message_id to reply under (== NormalizedFeishuEvent.deliveryId).
   * Replying under the user's message threads the answer in groups and reads
   * as a direct answer in p2p chats.
   */
  messageId: string;
  /** Invoked once when the writer detaches (sent / timed-out / no-text). */
  onDone?: () => void;
  /** Auto-close deadline; default 120s. Bounds writer lifetime on stalled turns. */
  timeoutMs?: number;
}

interface WriterState {
  closed: boolean;
  timer: NodeJS.Timeout | null;
}

/**
 * Build a one-shot EventWriter that mirrors the agent's first `agent.message`
 * reply back into Feishu. The hub's `attach` delivers only events published
 * AFTER attach, and the harness turn is fire-and-forget with a network model
 * call — so attach (synchronous, in the inbound handler) always precedes the
 * reply. No history replay, no missed reply.
 */
export function createFeishuEgressWriter(
  opts: FeishuEgressWriterOptions,
): EventWriter {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const state: WriterState = { closed: false, timer: null };

  const detach = (): void => {
    if (state.closed) return;
    state.closed = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    opts.onDone?.();
  };

  state.timer = setTimeout(() => {
    log.warn(
      { op: "feishu_egress.timeout", reply_to: opts.messageId, timeout_ms: timeoutMs },
      "egress writer timed out before an agent reply; closing",
    );
    detach();
  }, timeoutMs);

  return {
    get closed(): boolean {
      return state.closed;
    },
    write(event): void {
      if (state.closed) return;
      if (event.type !== "agent.message") return;

      const text = extractText(
        (event as { content?: unknown }).content,
      );
      // Close FIRST so a duplicate `agent.message` (e.g. a second turn on the
      // same session) doesn't double-send; the hub sweeps closed writers on
      // its next publish.
      detach();

      if (!text.trim()) {
        log.debug(
          { op: "feishu_egress.empty", reply_to: opts.messageId },
          "agent.message carried no text; nothing to send",
        );
        return;
      }
      void opts.client
        .replyText({ messageId: opts.messageId, text })
        .then(
          (res) => {
            log.info(
              {
                op: "feishu_egress.sent",
                reply_to: opts.messageId,
                message_id: res.messageId,
                len: text.length,
              },
              "feishu reply sent",
            );
          },
          (err: unknown) => {
            log.warn(
              {
                err: err instanceof Error ? err.message : String(err),
                op: "feishu_egress.send_failed",
                reply_to: opts.messageId,
              },
              "feishu reply failed",
            );
          },
        );
    },
    close(): void {
      detach();
    },
  };
}

/**
 * Concatenate all text blocks from an assistant message's content array.
 * Non-text blocks (tool calls, images) are ignored — egress mirrors natural
 * language only, since a Feishu text reply of a tool-call blob is noise.
 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => isTextBlock(b))
    .map((b) => b.text)
    .join("");
}

function isTextBlock(b: unknown): b is { type: "text"; text: string } {
  return (
    typeof b === "object" &&
    b !== null &&
    (b as { type?: unknown }).type === "text" &&
    typeof (b as { text?: unknown }).text === "string"
  );
}
