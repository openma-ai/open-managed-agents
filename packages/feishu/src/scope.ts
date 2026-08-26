// Feishu scope-key helper — single source of truth for the scope_key column
// in feishu_thread_sessions.
//
// Mirrors packages/slack/src/provider.ts::scopeKeyFor but Feishu has no
// thread_ts. The granularity mapping is:
//
//   per_chat        → `chat:${chatId}`
//                      One session per (publication, chat). Group chats
//                      share the same session across users; DMs collapse
//                      to a single session per chat_id (= the user's
//                      1-on-1 chat with the bot).
//
//   per_chat_user   → `chat:${chatId}:user:${senderOpenId}`
//                      One session per (publication, chat, user). Each
//                      DM gets its own session; in groups each user has
//                      their own conversation. **Default** granularity.
//
//   per_event       → null
//                      Every message creates a throwaway session. The
//                      scope row is not persisted.
//
// Returns null when the event lacks the fields needed for the requested
// granularity (e.g. uninstall events with no chatId).
import type { SessionGranularity } from "@open-managed-agents/integrations-core";
import type { NormalizedFeishuEvent } from "./webhook/parse";

export function scopeKeyFor(
  event: NormalizedFeishuEvent,
  granularity: SessionGranularity,
): string | null {
  if (!event.chatId) return null;
  switch (granularity) {
    case "per_chat":
      return `chat:${event.chatId}`;
    case "per_chat_user":
      if (!event.senderOpenId) return null;
      return `chat:${event.chatId}:user:${event.senderOpenId}`;
    case "per_thread":
      // Feishu has no thread_ts — fall through to per_chat_user if sender
      // present, else per_chat.
      if (event.senderOpenId) return `chat:${event.chatId}:user:${event.senderOpenId}`;
      return `chat:${event.chatId}`;
    case "per_event":
    case "per_issue":
      return null;
    default:
      return null;
  }
}
