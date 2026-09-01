import { describe, expect, it } from "vitest";
import { connectHttpMcpClient } from "../../packages/mcp/src/http-client";
import {
  createScriptedMcpServer,
  type ScriptedMcpServerOptions,
} from "../fakes/scripted-mcp-server";

function echoServer(options: {
  methodPlans?: ScriptedMcpServerOptions["methodPlans"];
} = {}) {
  return createScriptedMcpServer({
    sessionId: "client-session-1",
    tools: [{
      name: "echo",
      title: "Echo",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    }],
    methodPlans: options.methodPlans,
    callTool({ arguments: args }) {
      return {
        content: [{ type: "text", text: `echo:${String(args?.value)}` }],
        structuredContent: { echoed: args?.value },
      };
    },
  });
}

function connect(
  fake: ReturnType<typeof createScriptedMcpServer>,
  overrides: Partial<Parameters<typeof connectHttpMcpClient>[0]> = {},
) {
  return connectHttpMcpClient({
    url: "https://mcp.example.test/rpc",
    clientInfo: { name: "protocol-coverage", version: "1.0.0" },
    fetch: fake.fetch,
    versionNegotiation: "legacy",
    timeoutMs: 100,
    closeTimeoutMs: 10,
    ...overrides,
  });
}

describe("HTTP MCP client protocol lifecycle", () => {
  it("preserves official list/call/session shapes and closes idempotently", async () => {
    const fake = echoServer();
    const client = await connect(fake, {
      versionNegotiation: "auto",
      requestInit: { headers: { "x-protocol-test": "strict" } },
    });
    const abortController = new AbortController();

    await expect(client.listTools({
      timeoutMs: 50,
      signal: abortController.signal,
    })).resolves.toEqual([
      expect.objectContaining({ name: "echo", title: "Echo" }),
    ]);
    await expect(client.callTool({
      name: "echo",
      arguments: { value: "covered" },
    }, { timeoutMs: 50 })).resolves.toMatchObject({
      content: [{ type: "text", text: "echo:covered" }],
      structuredContent: { echoed: "covered" },
    });

    await client.close();
    await client.close();
    expect(fake.state.counts).toMatchObject({
      "server/discover": 1,
      initialize: 1,
      "notifications/initialized": 1,
      "tools/list": 1,
      "tools/call": 1,
      DELETE: 1,
    });
    expect(fake.state.requests.every(
      (request) => request.headers.get("x-protocol-test") === "strict",
    )).toBe(true);
  });

  it("surfaces JSON-RPC tool errors, then allows a later successful call", async () => {
    const fake = echoServer({
      methodPlans: {
        "tools/call": [
          { type: "json-rpc-error", code: -32001, message: "server busy" },
          { type: "pass" },
        ],
      },
    });
    const client = await connect(fake);

    await expect(client.callTool({ name: "echo", arguments: { value: "first" } }))
      .rejects.toThrow("server busy");
    await expect(client.callTool({ name: "echo", arguments: { value: "second" } }))
      .resolves.toMatchObject({ structuredContent: { echoed: "second" } });
    fake.assertPlanExhausted();
    await client.close();
  });

  it("rejects a disconnected initialize without leaving a usable client", async () => {
    const fake = createScriptedMcpServer({
      methodPlans: {
        initialize: [{ type: "disconnect", error: new TypeError("handshake reset") }],
      },
    });
    await expect(connect(fake)).rejects.toThrow("handshake reset");
    expect(fake.state.counts.initialize).toBe(1);
    fake.assertPlanExhausted();
  });

  it("bounds a hanging remote DELETE while still making local close idempotent", async () => {
    const fake = echoServer({
      methodPlans: { DELETE: [{ type: "hang" }] },
    });
    const client = await connect(fake, { closeTimeoutMs: 5 });

    const startedAt = performance.now();
    await client.close();
    await client.close();
    // Keep the assertion well below a network-scale timeout without making
    // the test sensitive to a busy CI event loop.
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(fake.state.counts.DELETE).toBe(1);
    fake.assertPlanExhausted();
  });

  it("treats remote DELETE failures as best-effort cleanup", async () => {
    const fake = echoServer({
      methodPlans: {
        DELETE: [{ type: "http-error", status: 503, body: "close unavailable" }],
      },
    });
    const client = await connect(fake);

    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
    expect(fake.state.counts.DELETE).toBe(1);
    fake.assertPlanExhausted();
  });
});
