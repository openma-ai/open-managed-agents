// @ts-nocheck
import { env, exports } from "cloudflare:workers";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultHarness } from "../../apps/agent/src/harness/default-loop";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import { getCfServicesForTenant } from "@open-managed-agents/services";

const HEADERS = {
  "x-api-key": "test-key",
  "content-type": "application/json",
};
const MCP_ORIGIN = "https://managed-turn-mcp.example.test";
const BROKEN_MCP_ORIGIN = "https://broken-managed-turn-mcp.example.test";
const OAUTH_ORIGIN = "https://managed-turn-oauth.example.test";
const HARNESS_NAME = "managed-turn-mcp-e2e";

let turnModel: MockLanguageModelV3 | null = null;

registerHarness(HARNESS_NAME, () => {
  const harness = new DefaultHarness();
  return {
    async run(ctx) {
      if (!turnModel) throw new Error("managed-turn fake LLM was not installed");
      await harness.run({ ...ctx, model: turnModel });
    },
  };
});

function api(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

async function post(path: string, body: Record<string, unknown>) {
  return api(path, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

function usage() {
  return {
    inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 7, text: 7, reasoning: 0 },
  };
}

function modelStream(chunks: Array<Record<string, unknown>>) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function createTurnModel() {
  let call = 0;
  return new MockLanguageModelV3({
    provider: "openma-e2e-mock",
    modelId: "managed-turn-mock-model",
    doStream: async () => {
      call += 1;
      if (call === 1) {
        return {
          stream: modelStream([
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "mock-response-tool" },
            {
              type: "tool-input-start",
              id: "mcp-call-1",
              toolName: "mcp__fake__echo",
            },
            {
              type: "tool-input-delta",
              id: "mcp-call-1",
              delta: '{"value":"managed"}',
            },
            { type: "tool-input-end", id: "mcp-call-1" },
            {
              type: "tool-call",
              toolCallId: "mcp-call-1",
              toolName: "mcp__fake__echo",
              input: '{"value":"managed"}',
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_use" },
              usage: usage(),
            },
          ]),
        };
      }
      return {
        stream: modelStream([
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "mock-response-final" },
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: "MCP echo completed." },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: usage(),
          },
        ]),
      };
    },
  });
}

type ExternalState = {
  discoverCount: number;
  initializeCount: number;
  listCount: number;
  callCount: number;
  deleteCount: number;
  oauthRefreshCount: number;
  staleBearerCount: number;
  freshBearerCount: number;
  sawSessionOnToolCall: boolean;
};

function jsonRpcResult(id: string | number, result: Record<string, unknown>, headers?: HeadersInit) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function installExternalMocks(): { state: ExternalState; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const state: ExternalState = {
    discoverCount: 0,
    initializeCount: 0,
    listCount: 0,
    callCount: 0,
    deleteCount: 0,
    oauthRefreshCount: 0,
    staleBearerCount: 0,
    freshBearerCount: 0,
    sawSessionOnToolCall: false,
  };

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.origin === BROKEN_MCP_ORIGIN) {
      return new Response("broken external MCP", { status: 503 });
    }

    if (url.origin === OAUTH_ORIGIN) {
      state.oauthRefreshCount += 1;
      expect(request.method).toBe("POST");
      const body = new URLSearchParams(
        new TextDecoder().decode(await request.arrayBuffer()),
      );
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-token-1");
      return Response.json({
        access_token: "fresh-access-token",
        refresh_token: "refresh-token-2",
        token_type: "Bearer",
      });
    }

    if (url.origin !== MCP_ORIGIN) return originalFetch(input, init);

    const authorization = request.headers.get("authorization");
    if (authorization === "Bearer stale-access-token") {
      state.staleBearerCount += 1;
      return new Response("expired", { status: 401 });
    }
    if (authorization === "Bearer fresh-access-token") {
      state.freshBearerCount += 1;
    } else {
      return new Response("missing managed bearer", { status: 401 });
    }

    if (request.method === "DELETE") {
      state.deleteCount += 1;
      expect(request.headers.get("mcp-session-id")).toBe("managed-turn-session");
      return new Response(null, { status: 200 });
    }
    if (request.method === "GET") {
      // This fake has no unsolicited server events. 405 is the Streamable
      // HTTP signal that a standalone SSE listener is not supported.
      return new Response(null, { status: 405 });
    }

    const message = (await request.json()) as {
      id?: string | number;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (message.method === "server/discover") {
      state.discoverCount += 1;
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (message.method === "initialize") {
      state.initializeCount += 1;
      return jsonRpcResult(message.id!, {
        protocolVersion: message.params?.protocolVersion as string,
        capabilities: { tools: {} },
        serverInfo: { name: "managed-turn-fake", version: "1.0.0" },
      }, { "mcp-session-id": "managed-turn-session" });
    }
    if (message.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (message.method === "tools/list") {
      state.listCount += 1;
      return jsonRpcResult(message.id!, {
        tools: [{
          name: "echo",
          description: "Echo a value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        }],
      });
    }
    if (message.method === "tools/call") {
      state.callCount += 1;
      state.sawSessionOnToolCall =
        request.headers.get("mcp-session-id") === "managed-turn-session";
      const args = message.params?.arguments as { value?: string } | undefined;
      return jsonRpcResult(message.id!, {
        content: [{ type: "text", text: `echo:${args?.value}` }],
        structuredContent: { echoed: args?.value },
      });
    }

    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  return {
    state,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

async function waitForCompletedTurn(sessionId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await api(`/v1/oma/sessions/${sessionId}/events?limit=100`, {
      headers: HEADERS,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    const events = body.data.map((row) =>
      row.data && typeof row.data === "object"
        ? row.data as Record<string, unknown>
        : row);
    if (events.some((event) =>
      event.type === "agent.message"
      && JSON.stringify(event.content ?? "").includes("MCP echo completed."))) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("managed MCP turn did not complete");
}

afterEach(() => {
  turnModel = null;
});

describe("managed turn MCP E2E", () => {
  it("keeps OpenMA internals real while mocking only LLM, MCP, and OAuth", async () => {
    expect(env.MAIN_MCP).toBeDefined();

    const external = installExternalMocks();
    turnModel = createTurnModel();
    try {
      const vaultResponse = await post("/v1/oma/vaults", {
        name: `managed-turn-vault-${crypto.randomUUID()}`,
      });
      expect(vaultResponse.status).toBe(201);
      const vault = (await vaultResponse.json()) as { id: string };

      const credentialResponse = await post(
        `/v1/oma/vaults/${vault.id}/credentials`,
        {
          display_name: "Managed turn MCP OAuth",
          auth: {
            type: "mcp_oauth",
            mcp_server_url: `${MCP_ORIGIN}/rpc`,
            access_token: "stale-access-token",
            refresh_token: "refresh-token-1",
            token_endpoint: `${OAUTH_ORIGIN}/token`,
            client_id: "managed-turn-client",
          },
        },
      );
      expect(credentialResponse.status).toBe(201);
      const credential = (await credentialResponse.json()) as { id: string };

      const agentResponse = await post("/v1/oma/agents", {
        name: `Managed MCP turn ${crypto.randomUUID()}`,
        model: "managed-turn-model",
        system: "Use the MCP echo tool.",
        tools: [{ type: "agent_toolset_20260401" }],
        harness: HARNESS_NAME,
        mcp_servers: [
          {
            name: "broken",
            type: "url",
            url: `${BROKEN_MCP_ORIGIN}/rpc`,
            authorization_token: "broken-token",
          },
          { name: "fake", type: "url", url: `${MCP_ORIGIN}/rpc` },
        ],
      });
      expect(agentResponse.status).toBe(201);
      const agent = (await agentResponse.json()) as { id: string };

      const environmentResponse = await post("/v1/oma/environments", {
        name: `managed-turn-env-${crypto.randomUUID()}`,
        config: { type: "cloud" },
      });
      expect(environmentResponse.status).toBe(201);
      const environment = (await environmentResponse.json()) as { id: string };

      const sessionResponse = await post("/v1/oma/sessions", {
        agent: agent.id,
        environment_id: environment.id,
        vault_ids: [vault.id],
      });
      expect(sessionResponse.status).toBe(201);
      const session = (await sessionResponse.json()) as { id: string };

      const messageResponse = await post(`/v1/oma/sessions/${session.id}/events`, {
        events: [{
          type: "user.message",
          content: [{ type: "text", text: "Echo managed through MCP" }],
        }],
      });
      expect(messageResponse.status).toBe(202);

      const events = await waitForCompletedTurn(session.id);
      const mcpUse = events.find((event) => event.type === "agent.mcp_tool_use");
      const mcpResult = events.find((event) => event.type === "agent.mcp_tool_result");

      expect(mcpUse).toMatchObject({
        id: "mcp-call-1",
        mcp_server_name: "fake",
        name: "mcp__fake__echo",
        input: { value: "managed" },
      });
      expect(JSON.stringify(mcpResult?.content)).toContain("echo:managed");
      expect(mcpResult?.parent_event_id).toBe("mcp-call-1");

      const services = await getCfServicesForTenant(env, "default");
      const persistedCredential = await services.credentials.get({
        tenantId: "default",
        vaultId: vault.id,
        credentialId: credential.id,
      });
      expect(persistedCredential?.auth).toMatchObject({
        access_token: "fresh-access-token",
        refresh_token: "refresh-token-2",
      });

      expect(external.state).toMatchObject({
        discoverCount: 1,
        initializeCount: 1,
        listCount: 1,
        callCount: 1,
        oauthRefreshCount: 1,
        staleBearerCount: 1,
        sawSessionOnToolCall: true,
      });
      expect(external.state.deleteCount).toBe(1);
      expect(turnModel.doStreamCalls).toHaveLength(2);
    } finally {
      external.restore();
    }
  });
});
