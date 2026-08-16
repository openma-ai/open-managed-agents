import { beforeEach, describe, expect, it } from "vitest";
import type { HttpClient, HttpRequest, HttpResponse } from "@open-managed-agents/integrations-core";
import { FeishuApiClient, FeishuApiError } from "../src/api/client";

/** In-memory HttpClient that records calls and serves scripted responses. */
class FakeHttp implements HttpClient {
  public calls: HttpRequest[] = [];
  private scripts: Array<(req: HttpRequest) => HttpResponse> = [];
  private default: HttpResponse;

  constructor(defaultResponse: HttpResponse = { status: 200, headers: {}, body: "{}" }) {
    this.default = defaultResponse;
  }

  /** Push a one-shot response script. Order matters: scripts run in push
   *  order, then fall through to `defaultResponse`. */
  pushScript(script: (req: HttpRequest) => HttpResponse): void {
    this.scripts.push(script);
  }

  setDefault(response: HttpResponse): void {
    this.default = response;
  }

  async fetch(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    const script = this.scripts.shift();
    return script ? script(req) : this.default;
  }
}

function ok<T>(data: T, extra: Record<string, unknown> = {}): HttpResponse {
  return {
    status: 200,
    headers: {},
    body: JSON.stringify({ code: 0, msg: "ok", data, ...extra }),
  };
}

function err(code: number, msg: string, status = 200): HttpResponse {
  return { status, headers: {}, body: JSON.stringify({ code, msg }) };
}

describe("api/client — FeishuApiClient", () => {
  let http: FakeHttp;
  let client: FeishuApiClient;
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    http = new FakeHttp();
    client = new FeishuApiClient(
      { appId: "cli_test", appSecret: "secret_test", nowMs: () => NOW },
      http,
    );
  });

  describe("getTenantAccessToken", () => {
    it("mints a token on first call", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t-abc", expire: 7200 }));

      const tok = await client.getTenantAccessToken();
      expect(tok.accessToken).toBe("t-abc");
      expect(tok.rawExpire).toBe(7200);
      expect(tok.expiresAt).toBe(NOW + 7200 * 1000);

      expect(http.calls).toHaveLength(1);
      const call = http.calls[0]!;
      expect(call.url).toBe(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      );
      expect(call.method).toBe("POST");
      expect(JSON.parse(call.body ?? "{}")).toEqual({
        app_id: "cli_test",
        app_secret: "secret_test",
      });
    });

    it("returns cached token within TTL", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t-1", expire: 7200 }));
      await client.getTenantAccessToken();
      // Second call should NOT hit HTTP — cache hit.
      const tok2 = await client.getTenantAccessToken();
      expect(tok2.accessToken).toBe("t-1");
      expect(http.calls).toHaveLength(1);
    });

    it("refreshes when within 60s of expiry", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t-1", expire: 60 }));
      await client.getTenantAccessToken();
      // Now NOW+30s — within the 60s refresh buffer — should re-mint.
      http.pushScript(() => ok({ tenant_access_token: "t-2", expire: 7200 }));
      const tok2 = await client.getTenantAccessToken();
      expect(tok2.accessToken).toBe("t-2");
      expect(http.calls).toHaveLength(2);
    });

    it("single-flights concurrent mint calls", async () => {
      // The first script is intentionally slow to test concurrency.
      http.pushScript(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return ok({ tenant_access_token: "t-shared", expire: 7200 });
      });
      // Issue 5 concurrent calls.
      const results = await Promise.all(
        Array.from({ length: 5 }, () => client.getTenantAccessToken()),
      );
      // All 5 should resolve to the same token.
      expect(new Set(results.map((r) => r.accessToken)).size).toBe(1);
      // But the HTTP layer should have only been hit once.
      expect(http.calls).toHaveLength(1);
    });

    it("throws FeishuApiError on non-200 HTTP transport", async () => {
      http.pushScript(() => ({ status: 500, headers: {}, body: "upstream gone" }));
      await expect(client.getTenantAccessToken()).rejects.toThrow(FeishuApiError);
    });

    it("throws FeishuApiError on Feishu non-zero code", async () => {
      http.pushScript(() => err(99991663, "tenant not found"));
      // FeishuApiError is an Error subclass with `code` and `tenantKey`
      // fields; `msg` is folded into the Error message string.
      const caught = await client
        .getTenantAccessToken()
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(FeishuApiError);
      if (caught instanceof FeishuApiError) {
        expect(caught.code).toBe(99991663);
        expect(caught.message).toContain("tenant not found");
      }
    });

    it("uses Date.now when nowMs is not provided", async () => {
      const http2 = new FakeHttp();
      const c2 = new FeishuApiClient({ appId: "x", appSecret: "y" }, http2);
      http2.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      const tok = await c2.getTenantAccessToken();
      // Just verify it doesn't throw and returns the token — Date.now
      // makes the absolute timestamp non-deterministic.
      expect(tok.accessToken).toBe("t");
    });
  });

  describe("refreshTenantAccessToken", () => {
    it("clears cache and re-mints", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t-1", expire: 7200 }));
      await client.getTenantAccessToken();
      http.pushScript(() => ok({ tenant_access_token: "t-2", expire: 7200 }));
      const tok = await client.refreshTenantAccessToken();
      expect(tok.accessToken).toBe("t-2");
      expect(http.calls).toHaveLength(2);
    });
  });

  describe("sendText", () => {
    it("POSTs to im/v1/messages with msg_type=text and JSON content", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      http.pushScript(() => ok({ message_id: "om_sent_1" }));

      const { messageId } = await client.sendText({ chatId: "oc_chat", text: "hello" });
      expect(messageId).toBe("om_sent_1");

      // The mint call is index 0; the sendText call is index 1.
      const sendCall = http.calls[1]!;
      // receive_id_type=chat_id is mandatory on the send endpoint — without
      // it Feishu rejects with 99991672 (invalid receive_id).
      expect(sendCall.url).toBe(
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
      );
      expect(sendCall.method).toBe("POST");
      expect(JSON.parse(sendCall.body ?? "{}")).toEqual({
        receive_id: "oc_chat",
        msg_type: "text",
        content: JSON.stringify({ text: "hello" }),
      });
      expect(sendCall.headers?.authorization).toBe("Bearer t");
    });
  });

  describe("replyText", () => {
    it("POSTs to im/v1/messages/{id}/reply with no receive_id", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      http.pushScript(() => ok({ message_id: "om_reply_1" }));

      const { messageId } = await client.replyText({
        messageId: "om_inbound_9",
        text: "ack",
      });
      expect(messageId).toBe("om_reply_1");

      // The mint call is index 0; the reply call is index 1.
      const replyCall = http.calls[1]!;
      expect(replyCall.url).toBe(
        "https://open.feishu.cn/open-apis/im/v1/messages/om_inbound_9/reply",
      );
      expect(replyCall.method).toBe("POST");
      // The reply endpoint resolves the chat from the parent message, so no
      // receive_id / receive_id_type is sent in the body or query.
      expect(JSON.parse(replyCall.body ?? "{}")).toEqual({
        msg_type: "text",
        content: JSON.stringify({ text: "ack" }),
      });
      expect(replyCall.headers?.authorization).toBe("Bearer t");
    });

    it("URL-encodes the parent message_id", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      http.pushScript(() => ok({ message_id: "om_reply_2" }));

      await client.replyText({ messageId: "om_ /?", text: "x" });

      expect(http.calls[1]!.url).toBe(
        "https://open.feishu.cn/open-apis/im/v1/messages/om_%20%2F%3F/reply",
      );
    });
  });

  describe("updateText", () => {
    it("PUTs to im/v1/messages/{id}", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      http.pushScript(() => ok({}));

      await client.updateText({ messageId: "om_msg_2", text: "edited" });

      const putCall = http.calls[1]!;
      expect(putCall.url).toBe("https://open.feishu.cn/open-apis/im/v1/messages/om_msg_2");
      expect(putCall.method).toBe("PUT");
      expect(JSON.parse(putCall.body ?? "{}")).toEqual({
        msg_type: "text",
        content: JSON.stringify({ text: "edited" }),
      });
    });
  });

  describe("getChatName", () => {
    it("returns chat name when present", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      http.pushScript(() => ok({ name: "Engineering" }));
      expect(await client.getChatName("oc_c")).toBe("Engineering");
    });

    it("returns null when chat not found (Feishu code 99991663)", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      http.pushScript(() => err(99991663, "chat not found"));
      expect(await client.getChatName("oc_missing")).toBeNull();
    });

    it("throws on other non-zero codes", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      http.pushScript(() => err(230002, "permission denied"));
      await expect(client.getChatName("oc_c")).rejects.toBeInstanceOf(FeishuApiError);
    });

    it("returns null when name field is absent", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      http.pushScript(() => ok({}));
      expect(await client.getChatName("oc_c")).toBeNull();
    });
  });

  describe("addReaction", () => {
    it("POSTs emoji reaction to message", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      http.pushScript(() => ok({}));

      await client.addReaction({ messageId: "om_m", emojiType: "THUMBSUP" });

      const call = http.calls[1]!;
      expect(call.url).toBe(
        "https://open.feishu.cn/open-apis/im/v1/messages/om_m/reactions",
      );
      expect(call.method).toBe("POST");
      expect(JSON.parse(call.body ?? "{}")).toEqual({
        reaction_type: { emoji_type: "THUMBSUP" },
      });
    });
  });

  describe("removeReaction", () => {
    it("DELETEs reaction", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      http.pushScript(() => ok({}));

      await client.removeReaction({ messageId: "om_m", emojiType: "THUMBSUP" });

      const call = http.calls[1]!;
      expect(call.url).toBe(
        "https://open.feishu.cn/open-apis/im/v1/messages/om_m/reactions",
      );
      expect(call.method).toBe("DELETE");
      expect(call.headers?.authorization).toBe("Bearer t");
    });
  });

  describe("refresh-on-401", () => {
    it("retries once with a fresh token after 401", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t-old", expire: 7200 }));
      // First sendText attempt: 401.
      http.pushScript(() => ({ status: 401, headers: {}, body: "unauthorized" }));
      // Refresh mint.
      http.pushScript(() => ok({ tenant_access_token: "t-new", expire: 7200 }));
      // Retry sendText succeeds.
      http.pushScript(() => ok({ message_id: "om_retry" }));

      const { messageId } = await client.sendText({ chatId: "c", text: "hi" });
      expect(messageId).toBe("om_retry");
      // 4 calls total: mint + sendText + mint + sendText
      expect(http.calls).toHaveLength(4);
    });

    it("throws FeishuApiError on 5xx transport", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      http.pushScript(() => ({ status: 503, headers: {}, body: "down" }));
      await expect(client.sendText({ chatId: "c", text: "x" })).rejects.toBeInstanceOf(
        FeishuApiError,
      );
    });
  });

  describe("non-JSON responses", () => {
    it("throws FeishuApiError (not raw SyntaxError) on a non-JSON body", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      // A gateway/HTML error page served with 200 — passes the 5xx guard,
      // then hits the JSON parse. Must surface as a structured error instead
      // of leaking an opaque "Unexpected token <" SyntaxError.
      http.pushScript(() => ({ status: 200, headers: {}, body: "<html>Bad Gateway</html>" }));

      const caught = await client.getChatName("oc_c").catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(FeishuApiError);
      expect(caught).not.toBeInstanceOf(SyntaxError);
      if (caught instanceof FeishuApiError) {
        expect(caught.code).toBe(200);
        expect(caught.message).toContain("non-JSON");
        expect(caught.message).toContain("Bad Gateway");
      }
    });

    it("truncates a long non-JSON body in the error message", async () => {
      http.pushScript(() => ok({ tenant_access_token: "t", expire: 7200 }));
      const long = `<html>${"x".repeat(500)}</html>`;
      // Status < 500 so it reaches the parse step (5xx would short-circuit).
      http.pushScript(() => ({ status: 200, headers: {}, body: long }));

      const caught = await client.getChatName("oc_c").catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(FeishuApiError);
      if (caught instanceof FeishuApiError) {
        // 200-char snippet + ellipsis — not the full 500-char body.
        expect(caught.message.length).toBeLessThan(long.length);
        expect(caught.message).toContain("…");
      }
    });
  });
});
