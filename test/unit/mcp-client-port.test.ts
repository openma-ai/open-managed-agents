import { describe, expect, it } from "vitest";
import * as harnessTools from "../../apps/agent/src/harness/tools";
import { TestSandbox } from "../../apps/agent/src/runtime/sandbox";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
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

function createFakeMcpFetch(options: { hangDelete?: boolean } = {}) {
  const requests: Request[] = [];
  let deleteCount = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request.clone());

    if (request.method === "DELETE") {
      deleteCount += 1;
      if (options.hangDelete) {
        return new Promise<Response>(() => undefined);
      }
      return new Response(null, { status: 200 });
    }

    const message = (await request.json()) as JsonRpcMessage;
    if (message.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (message.method === "initialize") {
      return jsonRpcResult(message.id!, {
        protocolVersion: message.params?.protocolVersion as string,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      }, { "mcp-session-id": "mcp-session-1" });
    }

    if (message.method === "tools/list") {
      return jsonRpcResult(message.id!, {
        tools: [{
          name: "echo",
          title: "Echo",
          description: "Echo an input value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          outputSchema: {
            type: "object",
            properties: { echoed: { type: "string" } },
            required: ["echoed"],
          },
        }],
      });
    }

    if (message.method === "tools/call") {
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
    fetch,
    requests,
    get deleteCount() {
      return deleteCount;
    },
  };
}

describe("OpenMA MCP client port", () => {
  it("keeps the official MCP shape while allowing a platform-owned fetch", async () => {
    const connectHttpMcpClient = (
      harnessTools as Record<string, unknown>
    ).connectHttpMcpClient as undefined | ((options: Record<string, unknown>) => Promise<{
      listTools(options?: { timeoutMs?: number }): Promise<Array<Record<string, unknown>>>;
      callTool(
        input: { name: string; arguments?: Record<string, unknown> },
        options?: { timeoutMs?: number },
      ): Promise<Record<string, unknown>>;
      close(): Promise<void>;
    }>);
    expect(connectHttpMcpClient).toBeTypeOf("function");

    const fake = createFakeMcpFetch();
    const platformFetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      request.headers.set("x-openma-port", "strict");
      return fake.fetch(request);
    };

    const client = await connectHttpMcpClient!({
      url: "https://mcp.example.test/rpc",
      clientInfo: { name: "openma-test", version: "1.0.0" },
      fetch: platformFetch,
      versionNegotiation: "legacy",
      timeoutMs: 1_000,
    });

    const definitions = await client.listTools({ timeoutMs: 1_000 });
    expect(definitions).toEqual([
      expect.objectContaining({
        name: "echo",
        title: "Echo",
        inputSchema: expect.objectContaining({ type: "object" }),
        outputSchema: expect.objectContaining({ type: "object" }),
      }),
    ]);

    await expect(client.callTool({
      name: "echo",
      arguments: { value: "hello" },
    }, { timeoutMs: 1_000 })).resolves.toEqual(expect.objectContaining({
      content: [{ type: "text", text: "echo:hello" }],
      structuredContent: { echoed: "hello" },
    }));

    expect(fake.requests.every((request) => request.headers.get("x-openma-port") === "strict")).toBe(true);
    const postInitRequests = fake.requests.filter((request) => request.method === "POST").slice(1);
    expect(postInitRequests.every((request) => request.headers.get("mcp-session-id") === "mcp-session-1")).toBe(true);

    await client.close();
    await client.close();
    expect(fake.deleteCount).toBe(1);
  });

  it("projects MCP tools into a disposable harness tool set", async () => {
    const disposeTools = (
      harnessTools as Record<string, unknown>
    ).disposeTools as undefined | ((tools: Record<string, unknown>) => Promise<void>);
    expect(disposeTools).toBeTypeOf("function");

    const fake = createFakeMcpFetch();
    const tools = await harnessTools.buildTools({
      id: "agent_mcp_port",
      name: "MCP Port Agent",
      model: "claude-sonnet-4-6",
      system: "",
      tools: [{ type: "agent_toolset_20260401" }],
      mcp_servers: [{ name: "demo", type: "sse", url: "https://mcp.example.test/rpc" }],
      version: 1,
      created_at: new Date().toISOString(),
    }, new TestSandbox(), {
      mcpBinding: { fetch: fake.fetch },
      tenantId: "tenant-1",
      sessionId: "session-1",
    });

    const echo = tools.mcp__demo__echo;
    expect(echo).toBeDefined();
    expect(echo.inputSchema.jsonSchema).toEqual(expect.objectContaining({ type: "object" }));

    await expect(echo.execute({ value: "managed" }, {
      toolCallId: "tool-1",
      messages: [],
      abortSignal: undefined,
    })).resolves.toEqual(expect.objectContaining({
      content: [{ type: "text", text: "echo:managed" }],
      structuredContent: { echoed: "managed" },
    }));

    expect(fake.requests.every((request) => request.headers.get("x-oma-tenant") === "tenant-1")).toBe(true);
    expect(fake.requests.every((request) => request.headers.get("x-oma-session") === "session-1")).toBe(true);
    expect(fake.requests.every((request) => request.headers.get("x-oma-mcp-server") === "demo")).toBe(true);

    await disposeTools!(tools);
    await disposeTools!(tools);
    expect(fake.deleteCount).toBe(1);
  });

  it("bounds remote session termination so local disposal cannot hang", async () => {
    const connectHttpMcpClient = (
      harnessTools as Record<string, unknown>
    ).connectHttpMcpClient as (options: Record<string, unknown>) => Promise<{
      close(): Promise<void>;
    }>;
    const fake = createFakeMcpFetch({ hangDelete: true });
    const client = await connectHttpMcpClient({
      url: "https://mcp.example.test/rpc",
      clientInfo: { name: "openma-test", version: "1.0.0" },
      fetch: fake.fetch,
      versionNegotiation: "legacy",
      timeoutMs: 1_000,
      closeTimeoutMs: 10,
    });

    const closed = await Promise.race([
      client.close().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    expect(closed).toBe(true);
    expect(fake.deleteCount).toBe(1);
  });
});
