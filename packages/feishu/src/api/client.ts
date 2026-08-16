// Feishu OpenAPI client.
//
// Wraps the subset of Feishu's OpenAPI surface OMA needs:
//   - auth/v3/tenant_access_token/internal — mint + cache tenant_access_token
//   - im/v1/messages — send + update + list messages
//   - im/v1/chats/{chat_id} — chat metadata (display name)
//   - im/v1/messages/{message_id}/reactions — add/remove reactions
//   - contact/v3/users/{open_id} — sender display name lookup
//
// Pure logic; no Web Fetch types — pass HttpClient from integrations-core.

import type { HttpClient } from "@open-managed-agents/integrations-core";

export interface FeishuTenantAccessToken {
  /** Bearer token; valid for ~2h. */
  accessToken: string;
  /** Absolute ms-epoch expiry timestamp. */
  expiresAt: number;
  /** Raw expire seconds from Feishu's response, preserved for diagnostics. */
  rawExpire: number;
}

export interface FeishuApiClientOptions {
  appId: string;
  appSecret: string;
  /** Clock for token-expiry comparisons; defaults to Date.now. */
  nowMs?: () => number;
}

export class FeishuApiError extends Error {
  readonly code: number;
  readonly tenantKey: string | null;
  constructor(args: { code: number; msg: string; tenantKey?: string }) {
    super(`feishu api ${args.code}: ${args.msg}`);
    this.code = args.code;
    this.tenantKey = args.tenantKey ?? null;
  }
}

interface FeishuEnvelope<T> {
  code: number;
  msg: string;
  data?: T;
  tenant_key?: string;
}

const FEISHU_BASE = "https://open.feishu.cn/open-apis";

/**
 * Feishu error code returned when a chat can't be accessed — the chat_id is
 * invalid, the bot was removed, or the bot was never a member. In
 * `getChatName` we treat this as "chat gone" (return null) rather than a
 * hard failure, so a vanished chat doesn't break message dispatch.
 */
const FEISHU_CHAT_NOT_ACCESSIBLE_CODE = 99991663;

export class FeishuApiClient {
  private cached: FeishuTenantAccessToken | null = null;
  private inflight: Promise<FeishuTenantAccessToken> | null = null;

  constructor(
    private readonly opts: FeishuApiClientOptions,
    private readonly http: HttpClient,
  ) {}

  /**
   * Returns a tenant_access_token, minting one on first call and after
   * expiry. Single-flight: concurrent callers share the same in-flight
   * refresh promise so we don't hammer Feishu's auth endpoint.
   */
  async getTenantAccessToken(): Promise<FeishuTenantAccessToken> {
    const now = this.now();
    if (this.cached && this.cached.expiresAt > now + 60_000) {
      return this.cached;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.mint().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Force-refresh (used by the runner after a 401 retry). */
  async refreshTenantAccessToken(): Promise<FeishuTenantAccessToken> {
    this.cached = null;
    return this.getTenantAccessToken();
  }

  /**
   * POST im/v1/messages — send a text message into a chat.
   *
   * `receive_id_type=chat_id` is mandatory: without it Feishu rejects the
   * send with 99991672 (invalid receive_id). This endpoint was historically
   * unexercised (the WS ingest path never sent), so the omission was latent.
   */
  async sendText(input: {
    chatId: string;
    text: string;
  }): Promise<{ messageId: string }> {
    const res = await this.postJson<{ message_id: string }>(
      "/im/v1/messages?receive_id_type=chat_id",
      {
        receive_id: input.chatId,
        msg_type: "text",
        content: JSON.stringify({ text: input.text }),
      },
    );
    return { messageId: res.message_id };
  }

  /**
   * POST im/v1/messages/{id}/reply — reply to a specific inbound message.
   *
   * Used by the automatic-egress path so bot replies thread under the user's
   * message in group chats (and read as a direct answer in p2p). The reply
   * endpoint resolves the target chat from the parent message_id, so it needs
   * no `receive_id` / `receive_id_type`.
   */
  async replyText(input: {
    messageId: string;
    text: string;
  }): Promise<{ messageId: string }> {
    const res = await this.postJson<{ message_id: string }>(
      `/im/v1/messages/${encodeURIComponent(input.messageId)}/reply`,
      {
        msg_type: "text",
        content: JSON.stringify({ text: input.text }),
      },
    );
    return { messageId: res.message_id };
  }

  /** PUT im/v1/messages/{id} — update a previously-sent message. */
  async updateText(input: {
    messageId: string;
    text: string;
  }): Promise<void> {
    await this.putJson(`/im/v1/messages/${encodeURIComponent(input.messageId)}`, {
      msg_type: "text",
      content: JSON.stringify({ text: input.text }),
    });
  }

  /** GET im/v1/chats/{chat_id} — chat display name. */
  async getChatName(chatId: string): Promise<string | null> {
    try {
      const res = await this.getJson<{ name?: string }>(
        `/im/v1/chats/${encodeURIComponent(chatId)}`,
      );
      return res.name ?? null;
    } catch (err) {
      if (err instanceof FeishuApiError && err.code === FEISHU_CHAT_NOT_ACCESSIBLE_CODE) {
        // chat not found / bot removed — return null
        return null;
      }
      throw err;
    }
  }

  /** POST im/v1/messages/{id}/reactions — add an emoji reaction. */
  async addReaction(input: {
    messageId: string;
    emojiType: string;
  }): Promise<void> {
    await this.postJson<unknown>(
      `/im/v1/messages/${encodeURIComponent(input.messageId)}/reactions`,
      { reaction_type: { emoji_type: input.emojiType } },
    );
  }

  /** DELETE im/v1/messages/{id}/reactions — remove a reaction. */
  async removeReaction(input: {
    messageId: string;
    emojiType: string;
  }): Promise<void> {
    await this.deleteJson(
      `/im/v1/messages/${encodeURIComponent(input.messageId)}/reactions`,
    );
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private now(): number {
    return this.opts.nowMs?.() ?? Date.now();
  }

  private async mint(): Promise<FeishuTenantAccessToken> {
    const body = JSON.stringify({
      app_id: this.opts.appId,
      app_secret: this.opts.appSecret,
    });
    const res = await this.http.fetch({
      method: "POST",
      url: `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`,
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
    });
    if (res.status !== 200) {
      throw new FeishuApiError({
        code: res.status,
        msg: `auth mint failed: HTTP ${res.status}`,
      });
    }
    const parsed = this.parseEnvelope<{ tenant_access_token?: string; expire?: number }>(
      res.body,
      res.status,
    );
    // The auth/v3/tenant_access_token/internal response carries
    // tenant_access_token + expire at the TOP LEVEL (no `data` wrapper), e.g.
    //   {"code":0,"msg":"ok","tenant_access_token":"t-…","expire":7200}
    // parseEnvelope models only {code,msg,data,tenant_key}, so reach the
    // top-level token fields via a structural cast. Coerce code (Feishu emits
    // numeric or string "0") and read the token from top-level or data.
    if (Number(parsed.code) !== 0) {
      throw new FeishuApiError({
        code: Number(parsed.code),
        msg: parsed.msg,
        tenantKey: parsed.tenant_key,
      });
    }
    const envelope = parsed as unknown as {
      tenant_access_token?: string;
      expire?: number;
      data?: { tenant_access_token?: string; expire?: number };
    };
    const accessToken = envelope.tenant_access_token ?? envelope.data?.tenant_access_token;
    const expire = envelope.expire ?? envelope.data?.expire;
    if (!accessToken || typeof expire !== "number") {
      throw new FeishuApiError({
        code: Number(parsed.code),
        msg: `auth response missing tenant_access_token/expire: ${res.body.slice(0, 200)}`,
        tenantKey: parsed.tenant_key,
      });
    }
    const token: FeishuTenantAccessToken = {
      accessToken,
      // Feishu's `expire` is in seconds and is the relative TTL, not absolute.
      expiresAt: this.now() + expire * 1000,
      rawExpire: expire,
    };
    this.cached = token;
    return token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getTenantAccessToken();
    return {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token.accessToken}`,
    };
  }

  /**
   * Parse a Feishu envelope, throwing a structured FeishuApiError on a
   * non-JSON body instead of leaking a raw SyntaxError. Non-JSON replies
   * happen on transport/gateway failures (HTML error pages, empty bodies),
   * which would otherwise surface as an opaque "Unexpected token <" to the
   * WS runner with no HTTP status or body context.
   */
  private parseEnvelope<T>(body: string, status: number): FeishuEnvelope<T> {
    try {
      return JSON.parse(body) as FeishuEnvelope<T>;
    } catch {
      const snippet = body.length > 200 ? `${body.slice(0, 200)}…` : body;
      throw new FeishuApiError({
        code: status,
        msg: `unexpected non-JSON response (HTTP ${status}): ${snippet}`,
      });
    }
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>({
      method: "POST",
      url: `${FEISHU_BASE}${path}`,
      headers: { ...(await this.authHeaders()), "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
  }

  private async putJson(path: string, body: unknown): Promise<void> {
    await this.request({
      method: "PUT",
      url: `${FEISHU_BASE}${path}`,
      headers: await this.authHeaders(),
      body: JSON.stringify(body),
    });
  }

  private async getJson<T>(path: string): Promise<T> {
    return this.request<T>({
      method: "GET",
      url: `${FEISHU_BASE}${path}`,
      headers: await this.authHeaders(),
    });
  }

  private async deleteJson(path: string): Promise<void> {
    await this.request<unknown>({
      method: "DELETE",
      url: `${FEISHU_BASE}${path}`,
      headers: await this.authHeaders(),
    });
  }

  private async request<T>(req: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<T> {
    let res = await this.http.fetch(req);
    // Refresh-on-401: tenant_access_token may have rotated server-side.
    if (res.status === 401) {
      await this.refreshTenantAccessToken();
      res = await this.http.fetch({
        ...req,
        headers: { ...(req.headers ?? {}), ...(await this.authHeaders()) },
      });
    }
    if (res.status >= 500) {
      throw new FeishuApiError({
        code: res.status,
        msg: `transport error: HTTP ${res.status}`,
      });
    }
    const parsed = this.parseEnvelope<T>(res.body, res.status);
    // Coerce: Feishu returns numeric 0 here but string "0" on the reply
    // endpoint — both are success. A non-zero (numeric or string) is the error.
    if (Number(parsed.code) !== 0) {
      throw new FeishuApiError({
        code: Number(parsed.code),
        msg: parsed.msg,
        tenantKey: parsed.tenant_key,
      });
    }
    return parsed.data as T;
  }
}
