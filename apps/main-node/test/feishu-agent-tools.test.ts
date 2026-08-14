import { afterEach, describe, expect, it } from "vitest";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  Publication,
} from "@open-managed-agents/integrations-core";
import type { FeishuPublicationRepo } from "@open-managed-agents/feishu";
import {
  buildFeishuTools,
  configureFeishuAgentTools,
  resetFeishuAgentTools,
  resolveFeishuAgentTools,
  type SessionMetadataReader,
} from "../src/lib/feishu-agent-tools";

// Integration test for the in-process Feishu agent tools. Proves the reviewer's
// requested chain end-to-end at the tool boundary:
//
//   inbound session metadata (provider=feishu, publicationId)
//     → resolveFeishuAgentTools registers mcp__feishu__im_message_send /
//       mcp__feishu__im_chat_read against a FeishuApiClient
//     → tool execute() drives the Feishu OpenAPI over HTTP
//       (tenant-token mint is internal to FeishuApiClient)
//
// No real socket, no LLM — the model's tool invocation is simulated by calling
// execute() directly, which is exactly what the AI SDK does on a tool_use.

/** In-memory HttpClient: records every call, serves pushed one-shot scripts. */
class FakeHttp implements HttpClient {
  calls: HttpRequest[] = [];
  private scripts: Array<(req: HttpRequest) => HttpResponse> = [];
  private fallback: HttpResponse = { status: 200, headers: {}, body: "{}" };

  push(script: (req: HttpRequest) => HttpResponse): void {
    this.scripts.push(script);
  }

  async fetch(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    const script = this.scripts.shift();
    return script ? script(req) : this.fallback;
  }
}

function ok<T>(data: T, extra: Record<string, unknown> = {}): HttpResponse {
  return { status: 200, headers: {}, body: JSON.stringify({ code: 0, msg: "ok", data, ...extra }) };
}

/** Minimal publication — only `appId` is read by the resolver (via
 *  getCredentialState, since the base Publication type has no appId). */
function pub(appId: string): Publication {
  return {
    id: "pub_1",
    tenantId: "tnt_1",
    userId: "u_1",
    agentId: "a_1",
    environmentId: "e_1",
    installationId: "",
    status: "live",
    sessionGranularity: "per_chat_user",
    providerId: "feishu",
    mode: "full",
    persona: { name: "Bot", avatarUrl: null },
    capabilities: new Set(),
    appId,
  } as unknown as Publication;
}

/** Fake repo: returns a fixed appId (via credential state) + secret (or nulls
 *  to simulate missing/undecryptable rows). */
function fakePubs(appId: string | null, secret: string | null): FeishuPublicationRepo {
  return {
    get: async () => pub(appId ?? ""),
    getCredentialState: async () =>
      appId
        ? { appId, hasAppSecret: secret != null, hasVerificationToken: false, hasEncryptKey: false }
        : null,
    getAppSecret: async () => secret,
  } as unknown as FeishuPublicationRepo;
}

type Executable = { execute: (input: Record<string, unknown>) => Promise<unknown> };
function exec(tool: unknown): Executable {
  return tool as Executable;
}

describe("feishu-agent-tools — inbound → tool call → Feishu API", () => {
  afterEach(() => resetFeishuAgentTools());

  it("registers both feishu tools for a feishu session and drives sendText", async () => {
    const http = new FakeHttp();
    configureFeishuAgentTools({
      reader: (async () => ({
        provider: "feishu",
        publicationId: "pub_1",
        chatId: "oc_chat",
      })) as SessionMetadataReader,
      pubs: fakePubs("cli_a", "secret_a"),
      http,
    });

    const tools = await resolveFeishuAgentTools("sess_send");
    expect(Object.keys(tools).sort()).toEqual([
      "mcp__feishu__im_chat_read",
      "mcp__feishu__im_message_send",
    ]);

    // The model invoked the send tool. FeishuApiClient mints a token first.
    http.push(() => ok({ tenant_access_token: "t-abc", expire: 7200 }));
    http.push(() => ok({ message_id: "om_sent_1" }));

    const result = await exec(tools["mcp__feishu__im_message_send"]).execute({
      chat_id: "oc_chat",
      text: "hello from the agent",
    });

    expect(result).toEqual({ ok: true, message_id: "om_sent_1" });

    // call[0] = token mint; call[1] = the send the reviewer asked to see.
    const sendCall = http.calls[1]!;
    expect(sendCall.url).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    );
    expect(sendCall.method).toBe("POST");
    expect(JSON.parse(sendCall.body ?? "{}")).toEqual({
      receive_id: "oc_chat",
      msg_type: "text",
      content: JSON.stringify({ text: "hello from the agent" }),
    });
    // Token handling: the minted token is attached on the send request.
    expect(sendCall.headers?.authorization).toBe("Bearer t-abc");
  });

  it("im_chat_read drives the chat-info GET and returns the name", async () => {
    const http = new FakeHttp();
    configureFeishuAgentTools({
      reader: (async () => ({ provider: "feishu", publicationId: "pub_1" })) as SessionMetadataReader,
      pubs: fakePubs("cli_a", "secret_a"),
      http,
    });

    const tools = await resolveFeishuAgentTools("sess_read");
    http.push(() => ok({ tenant_access_token: "t", expire: 7200 }));
    http.push(() => ok({ name: "Engineering" }));

    const result = await exec(tools["mcp__feishu__im_chat_read"]).execute({ chat_id: "oc_eng" });
    expect(result).toEqual({ ok: true, name: "Engineering" });

    const chatCall = http.calls[1]!;
    expect(chatCall.url).toBe(
      "https://open.feishu.cn/open-apis/im/v1/chats/oc_eng",
    );
    expect(chatCall.method).toBe("GET");
  });

  it("token is minted once and reused across tools (per-app client cache)", async () => {
    const http = new FakeHttp();
    configureFeishuAgentTools({
      reader: (async () => ({ provider: "feishu", publicationId: "pub_1" })) as SessionMetadataReader,
      pubs: fakePubs("cli_a", "secret_a"),
      http,
    });

    // Two separate turns → two resolveFeishuAgentTools calls.
    const a = await resolveFeishuAgentTools("sess_t1");
    const b = await resolveFeishuAgentTools("sess_t2");

    http.push(() => ok({ tenant_access_token: "t", expire: 7200 }));
    http.push(() => ok({ message_id: "om_1" }));
    await exec(a["mcp__feishu__im_message_send"]).execute({ chat_id: "c", text: "x" });

    http.push(() => ok({ message_id: "om_2" }));
    await exec(b["mcp__feishu__im_message_send"]).execute({ chat_id: "c", text: "y" });

    // Only ONE token mint across the two turns — the per-app client is cached.
    const mints = http.calls.filter((c) =>
      c.url.includes("/auth/v3/tenant_access_token/internal"),
    );
    expect(mints).toHaveLength(1);
  });

  it("execute surfaces a send failure as a model-readable result, not a throw", async () => {
    const http = new FakeHttp();
    configureFeishuAgentTools({
      reader: (async () => ({ provider: "feishu", publicationId: "pub_1" })) as SessionMetadataReader,
      pubs: fakePubs("cli_a", "secret_a"),
      http,
    });

    const tools = await resolveFeishuAgentTools("sess_err");
    http.push(() => ok({ tenant_access_token: "t", expire: 7200 }));
    http.push(() => ({ status: 503, headers: {}, body: "upstream down" }));

    const result = await exec(tools["mcp__feishu__im_message_send"]).execute({
      chat_id: "oc_c",
      text: "x",
    });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/upstream|5|feishu/i);
  });

  it("returns {} for a non-feishu session (safe no-op spread)", async () => {
    configureFeishuAgentTools({
      reader: (async () => ({ provider: "slack", publicationId: "pub_1" })) as SessionMetadataReader,
      pubs: fakePubs("cli_a", "secret_a"),
      http: new FakeHttp(),
    });
    expect(await resolveFeishuAgentTools("sess_slack")).toEqual({});
  });

  it("returns {} when the publication secret cannot be decrypted", async () => {
    configureFeishuAgentTools({
      reader: (async () => ({ provider: "feishu", publicationId: "pub_1" })) as SessionMetadataReader,
      pubs: fakePubs("cli_a", null),
      http: new FakeHttp(),
    });
    expect(await resolveFeishuAgentTools("sess_nosec")).toEqual({});
  });

  it("returns {} when not configured (WS runner off)", async () => {
    // No configureFeishuAgentTools call — e.g. FEISHU_WS_RUNNER unset.
    expect(await resolveFeishuAgentTools("sess_unconf")).toEqual({});
  });

  it("buildFeishuTools (pure factory) drives the client without a resolver", async () => {
    const http = new FakeHttp();
    const client = new (await import("@open-managed-agents/feishu")).FeishuApiClient(
      { appId: "cli_a", appSecret: "secret_a" },
      http,
    );
    const tools = buildFeishuTools(client);
    http.push(() => ok({ tenant_access_token: "t", expire: 7200 }));
    http.push(() => ok({ message_id: "om_pure" }));

    const result = await exec(tools["mcp__feishu__im_message_send"]).execute({
      chat_id: "oc_p",
      text: "pure",
    });
    expect(result).toEqual({ ok: true, message_id: "om_pure" });
    expect(http.calls[1]!.url).toBe(
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    );
  });
});
