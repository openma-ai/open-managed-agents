// FeishuProvider configuration.
//
// Mirrors packages/slack/src/config.ts but adapted for Feishu's auth model:
//   - Feishu has NO per-install OAuth — the App's identity (app_id) carries
//     the tenant_access_token. Bot identity is the App itself.
//   - Feishu's URL verification handshake is HMAC-SHA256 over a nonce using
//     the App's `Encrypt Key` (legacy: Verification Token comparison).
//   - No `assistant:write`-style quirk. Capability set is narrower.

import type { SessionGranularity } from "@open-managed-agents/integrations-core";

/**
 * Feishu-specific capability keys gating OpenAPI operations. Stored as
 * opaque strings at the core boundary (CapabilityKey = string) so providers
 * don't collide. The integrations-core domain.ts CapabilityKey union already
 * lists these under "Feishu-specific"; this type narrows internally.
 */
export type FeishuCapabilityKey =
  | "im.message.read"
  | "im.message.send"
  | "im.message.update"
  | "im.message.delete"
  | "im.chat.read"
  | "im.chat.members"
  | "im.chat.create"
  | "im.reaction.add"
  | "im.reaction.remove"
  | "contact.user.read"
  | "bitable.read"
  | "bitable.write";

export interface FeishuConfig {
  /**
   * Public origin of the integrations gateway, used to build URLs surfaced
   * in the Console setup wizard (e.g. "https://integrations.example.com").
   * The Feishu WS runner does NOT require a public callback — events arrive
   * outbound. This origin is only used for the legacy URL-verification
   * handshake handler and the OAuth callback page (which is informational;
   * the WS runner is the real ingest).
   */
  gatewayOrigin: string;

  /**
   * Default capability set for new publications. Per-publication overrides
   * (which may only further restrict) are stored on the Publication row.
   */
  defaultCapabilities: ReadonlyArray<FeishuCapabilityKey>;

  /**
   * Default session granularity for new publications. `per_chat_user` is the
   * default (one session per (publication, chat, user)) — Feishu has no
   * threads so per_thread isn't applicable. `per_chat` collapses DMs by
   * chat_id only (one session per group). `per_event` is throwaway.
   */
  defaultSessionGranularity?: SessionGranularity;
}

/**
 * Bot scopes for an OMA agent published into Feishu. Covers the common path:
 * receive @-mentions and DMs, post messages, react, fetch user/chat
 * metadata. Scopes correspond to Feishu's permission names documented at
 * https://open.feishu.cn/document/server-docs/application-scope/introduction.
 */
export const DEFAULT_FEISHU_SCOPES: ReadonlyArray<string> = [
  // Receive im.message.receive_v1
  "im:message",
  "im:message.group_at_msg",
  "im:message.p2_at_msg",
  "im:message.read_as_app",
  // Send messages + reactions
  "im:message:send_as_bot",
  "im:message:update",
  "im:message:delete",
  "im:reaction",
  "im:reaction:write",
  // Chat membership / metadata
  "im:chat",
  "im:chat:read",
  "im:chat.members",
  // User / contact lookup
  "contact:user.id:readonly",
  "contact:user.basic:readonly",
  "contact:contact:readonly",
] as const;

/**
 * Event types the App subscribes to. The WebSocket long-poll subscribes via
 * `im.message.receive_v1` automatically — this list is the legacy HTTP
 * callback event subscription. Same names for compatibility with the
 * existing console wizard.
 */
export const DEFAULT_FEISHU_SUBSCRIBED_EVENTS: ReadonlyArray<string> = [
  "im.message.receive_v1",
] as const;

export const ALL_FEISHU_CAPABILITIES: ReadonlyArray<FeishuCapabilityKey> = [
  "im.message.read",
  "im.message.send",
  "im.message.update",
  "im.message.delete",
  "im.chat.read",
  "im.chat.members",
  "im.chat.create",
  "im.reaction.add",
  "im.reaction.remove",
  "contact.user.read",
  "bitable.read",
  "bitable.write",
] as const;
