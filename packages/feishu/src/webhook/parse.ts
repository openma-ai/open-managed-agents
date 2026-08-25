// Feishu webhook envelope parser.
//
// Mirrors packages/slack/src/webhook/parse.ts but for Feishu's two envelope
// shapes:
//
//   1. URL verification challenge (legacy HTTP callback, also reused for
//      setup confirmation):
//        { challenge: "<string>", token: "<verification_token>", type: "url_verification" }
//
//   2. Event callback (HTTP) / WS frame (long-poll) — both deliver the same
//      `im.message.receive_v1` shape:
//        { schema: "2.0", header: { event_type: "im.message.receive_v1", ... },
//          event: { sender: { sender_id, sender_type }, message: { ... }, chat: { ... } },
//          challenge?: string }
//
// The WS runner uses `parseWsFrame` (a thin wrapper over parseEventCallback
// that asserts schema=2.0). The HTTP webhook route uses `parseWebhook`.

import type { ProviderId } from "@open-managed-agents/integrations-core";

export type FeishuEventKind =
  | "url_verification"
  | "im.message.receive_v1"
  | "im.message.reaction.created_v1"
  | "bot_added"
  | "bot_removed";

export interface NormalizedFeishuEvent {
  kind: FeishuEventKind;
  /** Feishu's message_id (for im.* events) or synthetic key for lifecycle events. */
  deliveryId: string;
  /** Feishu's app_id (cli_…). */
  appId: string;
  /** Feishu chat_id. */
  chatId: string | null;
  /** Feishu chat_type: "p2p" (DM) | "group". */
  chatType: "p2p" | "group" | null;
  /** Sender open_id (user_…). Null for lifecycle events. */
  senderOpenId: string | null;
  /** Sender type: "user" | "app" | "bot". */
  senderType: string | null;
  /** Message text content (plain text only — cards deferred). */
  text: string | null;
  /** Message type (text, image, post, etc.). */
  messageType: string | null;
  /** Parent message_id for quoted/threaded replies. Feishu has no Slack-style thread_ts. */
  parentId: string | null;
  /** Cached chat display name (group/chat name). */
  chatName: string | null;
  /** URL verification challenge string (only when kind=url_verification). */
  challenge?: string;
}

export interface RawFeishuUrlVerification {
  challenge: string;
  token: string;
  type: "url_verification";
}

export interface RawFeishuEventCallbackHeader {
  event_id?: string;
  event_type: string;
  app_id?: string;
  tenant_key?: string;
  create_time?: string;
  token?: string;
}

export interface RawFeishuEventCallback {
  schema?: string;
  header?: RawFeishuEventCallbackHeader;
  event?: {
    sender?: {
      sender_id?: { open_id?: string; union_id?: string; user_id?: string };
      sender_type?: string;
    };
    message?: {
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      chat_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: { text?: string } | string;
    };
    chat?: { chat_id?: string; name?: string };
  };
}

export type RawFeishuEnvelope = RawFeishuUrlVerification | RawFeishuEventCallback;

/** Discriminator for which parse function to call. */
export function isUrlVerificationEnvelope(
  raw: unknown,
): raw is RawFeishuUrlVerification {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { type?: string }).type === "url_verification"
  );
}

export function isEventCallbackEnvelope(
  raw: unknown,
): raw is RawFeishuEventCallback {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as { header?: { event_type?: string }; schema?: string };
  return Boolean(
    (obj.header && typeof obj.header.event_type === "string") ||
      obj.schema === "2.0",
  );
}

/**
 * Parse a Feishu HTTP webhook body. Returns null for envelopes we don't
 * recognize — caller should respond 200 + drop silently.
 */
export function parseWebhook(raw: unknown): NormalizedFeishuEvent | null {
  if (isUrlVerificationEnvelope(raw)) {
    return {
      kind: "url_verification",
      deliveryId: `url_verification:${raw.challenge}`,
      appId: "",
      chatId: null,
      chatType: null,
      senderOpenId: null,
      senderType: null,
      text: null,
      messageType: null,
      parentId: null,
      chatName: null,
      challenge: raw.challenge,
    };
  }
  return parseEventCallback(raw);
}

/**
 * Parse a Feishu WebSocket frame. Asserts schema=2.0 and dispatches by
 * header.event_type. Mirrors `parseWebhook` for the WS ingest path.
 */
export function parseWsFrame(raw: unknown): NormalizedFeishuEvent | null {
  if (!isEventCallbackEnvelope(raw)) return null;
  return parseEventCallback(raw);
}

function parseEventCallback(
  raw: unknown,
): NormalizedFeishuEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const env = raw as RawFeishuEventCallback;
  const header = env.header;
  if (!header || !header.event_type) return null;
  const ev = env.event ?? {};
  const message = ev.message ?? {};
  const sender = ev.sender ?? {};
  const chat = ev.chat ?? {};

  const chatId = message.chat_id ?? chat.chat_id ?? null;
  const chatType =
    message.chat_type === "p2p" || message.chat_type === "group"
      ? message.chat_type
      : null;

  // content is either an object {text: "..."} or a JSON-stringified object.
  let text: string | null = null;
  if (typeof message.content === "object" && message.content !== null) {
    text = message.content.text ?? null;
  } else if (typeof message.content === "string") {
    try {
      const parsed = JSON.parse(message.content) as { text?: string };
      text = typeof parsed.text === "string" ? parsed.text : null;
    } catch {
      text = null;
    }
  }

  const kind = header.event_type as FeishuEventKind;
  const deliveryId =
    message.message_id ??
    header.event_id ??
    `${header.event_type}:${chatId ?? "?"}:${header.create_time ?? Date.now()}`;

  return {
    kind,
    deliveryId,
    appId: header.app_id ?? "",
    chatId,
    chatType,
    senderOpenId: sender.sender_id?.open_id ?? null,
    senderType: sender.sender_type ?? null,
    text,
    messageType: message.message_type ?? null,
    parentId: message.parent_id ?? message.root_id ?? null,
    chatName: chat.name ?? null,
  };
}

export const FEISHU_PROVIDER_ID: ProviderId = "feishu";
