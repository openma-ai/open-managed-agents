import { describe, expect, it } from "vitest";
import {
  isEventCallbackEnvelope,
  isUrlVerificationEnvelope,
  parseWebhook,
  parseWsFrame,
} from "../src/webhook/parse";

describe("webhook/parse", () => {
  describe("isUrlVerificationEnvelope", () => {
    it("returns true for type=url_verification envelopes", () => {
      expect(
        isUrlVerificationEnvelope({ type: "url_verification", challenge: "c", token: "t" }),
      ).toBe(true);
    });

    it("returns false for non-objects", () => {
      expect(isUrlVerificationEnvelope(null)).toBe(false);
      expect(isUrlVerificationEnvelope("string")).toBe(false);
      expect(isUrlVerificationEnvelope(42)).toBe(false);
    });

    it("returns false for objects without type=url_verification", () => {
      expect(isUrlVerificationEnvelope({ challenge: "c" })).toBe(false);
      expect(isUrlVerificationEnvelope({ type: "other" })).toBe(false);
    });
  });

  describe("isEventCallbackEnvelope", () => {
    it("returns true for header.event_type string", () => {
      expect(isEventCallbackEnvelope({ header: { event_type: "im.message.receive_v1" } })).toBe(
        true,
      );
    });

    it("returns true for schema=2.0 envelopes", () => {
      expect(isEventCallbackEnvelope({ schema: "2.0" })).toBe(true);
    });

    it("returns false for non-objects", () => {
      expect(isEventCallbackEnvelope(null)).toBe(false);
      expect(isEventCallbackEnvelope(undefined)).toBe(false);
      expect(isEventCallbackEnvelope("not-an-object")).toBe(false);
    });

    it("returns false for objects without header.event_type or schema=2.0", () => {
      expect(isEventCallbackEnvelope({})).toBe(false);
      expect(isEventCallbackEnvelope({ schema: "1.0" })).toBe(false);
      expect(isEventCallbackEnvelope({ header: {} })).toBe(false);
    });
  });

  describe("parseWebhook — url_verification", () => {
    it("normalizes a url_verification envelope", () => {
      const out = parseWebhook({
        type: "url_verification",
        challenge: "abc123",
        token: "vt_xyz",
      });
      expect(out).toEqual({
        kind: "url_verification",
        deliveryId: "url_verification:abc123",
        appId: "",
        chatId: null,
        chatType: null,
        senderOpenId: null,
        senderType: null,
        text: null,
        messageType: null,
        parentId: null,
        chatName: null,
        challenge: "abc123",
      });
    });
  });

  describe("parseWebhook — event callback", () => {
    it("normalizes a full im.message.receive_v1 envelope", () => {
      const raw = {
        schema: "2.0",
        header: {
          event_id: "evt_001",
          event_type: "im.message.receive_v1",
          app_id: "cli_app",
          tenant_key: "tk_1",
          create_time: "1700000000",
          token: "vt_xyz",
        },
        event: {
          sender: {
            sender_id: { open_id: "ou_user", union_id: "uu", user_id: "u_internal" },
            sender_type: "user",
          },
          message: {
            message_id: "om_msg_1",
            chat_id: "oc_chat",
            chat_type: "group",
            message_type: "text",
            content: { text: "hello world" },
            parent_id: "om_parent",
            root_id: "om_root",
          },
          chat: { chat_id: "oc_chat", name: "Engineering" },
        },
      };
      const out = parseWebhook(raw);
      expect(out).toEqual({
        kind: "im.message.receive_v1",
        deliveryId: "om_msg_1",
        appId: "cli_app",
        chatId: "oc_chat",
        chatType: "group",
        senderOpenId: "ou_user",
        senderType: "user",
        text: "hello world",
        messageType: "text",
        parentId: "om_parent",
        chatName: "Engineering",
      });
    });

    it("parses content as JSON-stringified object", () => {
      const out = parseWebhook({
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", app_id: "cli_x" },
        event: {
          message: {
            message_id: "m1",
            chat_id: "c1",
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "from json string" }),
          },
        },
      });
      expect(out?.text).toBe("from json string");
    });

    it("returns null text when content is malformed JSON string", () => {
      const out = parseWebhook({
        schema: "2.0",
        header: { event_type: "im.message.receive_v1" },
        event: {
          message: {
            message_id: "m1",
            content: "not json {",
          },
        },
      });
      expect(out?.text).toBeNull();
    });

    it("returns null text when content is missing", () => {
      const out = parseWebhook({
        schema: "2.0",
        header: { event_type: "im.message.receive_v1" },
        event: { message: { message_id: "m1" } },
      });
      expect(out?.text).toBeNull();
    });

    it("falls back to chat.chat_id when message.chat_id is absent", () => {
      const out = parseWebhook({
        schema: "2.0",
        header: { event_type: "im.message.receive_v1" },
        event: {
          chat: { chat_id: "oc_chat_only", name: "Chat Name" },
        },
      });
      expect(out?.chatId).toBe("oc_chat_only");
      expect(out?.chatName).toBe("Chat Name");
    });

    it("normalizes chat_type to null when neither p2p nor group", () => {
      const out = parseWebhook({
        schema: "2.0",
        header: { event_type: "im.message.receive_v1" },
        event: {
          message: { message_id: "m1", chat_id: "c1", chat_type: "channel" },
        },
      });
      expect(out?.chatType).toBeNull();
    });

    it("falls back to root_id when parent_id absent", () => {
      const out = parseWebhook({
        schema: "2.0",
        header: { event_type: "im.message.receive_v1" },
        event: {
          message: { message_id: "m1", root_id: "r1" },
        },
      });
      expect(out?.parentId).toBe("r1");
    });

    it("synthesizes deliveryId from event_type + chatId + create_time when message_id missing", () => {
      const out = parseWebhook({
        schema: "2.0",
        header: {
          event_type: "im.message.receive_v1",
          create_time: "1700000000000",
        },
        event: { message: { chat_id: "c1" } },
      });
      expect(out?.deliveryId).toBe("im.message.receive_v1:c1:1700000000000");
    });

    it("uses event_id as deliveryId when message_id missing and event_id present", () => {
      const out = parseWebhook({
        schema: "2.0",
        header: { event_type: "im.message.receive_v1", event_id: "evt_42" },
        event: { message: { chat_id: "c1" } },
      });
      expect(out?.deliveryId).toBe("evt_42");
    });

    it("returns null for non-event, non-url_verification input", () => {
      expect(parseWebhook({ foo: "bar" })).toBeNull();
      expect(parseWebhook(null)).toBeNull();
      expect(parseWebhook("string")).toBeNull();
    });

    it("returns null when header.event_type is absent", () => {
      expect(
        parseWebhook({ schema: "2.0", header: {}, event: { message: { message_id: "m" } } }),
      ).toBeNull();
    });

    it("normalizes bot_added lifecycle event", () => {
      const out = parseWebhook({
        schema: "2.0",
        header: { event_type: "bot_added", event_id: "evt_bot_added" },
        event: {
          chat: { chat_id: "oc_new_chat", name: "New Chat" },
        },
      });
      expect(out?.kind).toBe("bot_added");
      expect(out?.chatId).toBe("oc_new_chat");
      expect(out?.chatName).toBe("New Chat");
      expect(out?.deliveryId).toBe("evt_bot_added");
    });
  });

  describe("parseWsFrame", () => {
    it("parses a schema=2.0 WS frame", () => {
      const out = parseWsFrame({
        schema: "2.0",
        header: { event_type: "im.message.receive_v1" },
        event: {
          message: {
            message_id: "m1",
            chat_id: "c1",
            chat_type: "p2p",
            message_type: "text",
            content: { text: "ws hi" },
          },
        },
      });
      expect(out?.kind).toBe("im.message.receive_v1");
      expect(out?.text).toBe("ws hi");
    });

    it("returns null for non-event-callback envelopes", () => {
      expect(parseWsFrame({ type: "url_verification", challenge: "c", token: "t" })).toBeNull();
      expect(parseWsFrame({ foo: "bar" })).toBeNull();
    });
  });
});
