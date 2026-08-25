import { describe, expect, it } from "vitest";
import type { NormalizedFeishuEvent } from "../src/webhook/parse";
import { scopeKeyFor } from "../src/scope";

function ev(overrides: Partial<NormalizedFeishuEvent> = {}): NormalizedFeishuEvent {
  return {
    kind: "im.message.receive_v1",
    deliveryId: "d1",
    appId: "cli_x",
    chatId: "oc_chat_1",
    chatType: "group",
    senderOpenId: "ou_user_1",
    senderType: "user",
    text: null,
    messageType: null,
    parentId: null,
    chatName: null,
    ...overrides,
  };
}

describe("scope", () => {
  describe("scopeKeyFor", () => {
    it("returns chat-keyed scope for per_chat", () => {
      expect(scopeKeyFor(ev(), "per_chat")).toBe("chat:oc_chat_1");
    });

    it("returns chat×user scope for per_chat_user", () => {
      expect(scopeKeyFor(ev(), "per_chat_user")).toBe("chat:oc_chat_1:user:ou_user_1");
    });

    it("returns null for per_chat_user when sender is missing", () => {
      expect(scopeKeyFor(ev({ senderOpenId: null }), "per_chat_user")).toBeNull();
    });

    it("returns null when chatId is missing regardless of granularity", () => {
      const e = ev({ chatId: null });
      expect(scopeKeyFor(e, "per_chat")).toBeNull();
      expect(scopeKeyFor(e, "per_chat_user")).toBeNull();
    });

    it("per_thread falls back to per_chat_user when sender is present", () => {
      // Feishu has no thread_ts; per_thread collapses to per_chat_user if
      // sender is available, else per_chat.
      expect(scopeKeyFor(ev(), "per_thread")).toBe("chat:oc_chat_1:user:ou_user_1");
    });

    it("per_thread falls back to per_chat when sender is missing", () => {
      expect(scopeKeyFor(ev({ senderOpenId: null }), "per_thread")).toBe("chat:oc_chat_1");
    });

    it("returns null for per_event granularity", () => {
      expect(scopeKeyFor(ev(), "per_event")).toBeNull();
    });

    it("returns null for per_issue granularity", () => {
      // per_issue is a Linear-specific granularity; Feishu treats it as
      // no-scope (every event gets its own session).
      expect(scopeKeyFor(ev(), "per_issue")).toBeNull();
    });
  });
});
