import { describe, expect, it } from "vitest";
import {
  createScriptedLanguageModel,
  finishChunk,
  requestErrorStep,
  streamStep,
  textChunks,
  toolCallChunks,
} from "../fakes/scripted-language-model";
import {
  createScriptedMcpServer,
  type JsonRpcMessage,
} from "../fakes/scripted-mcp-server";

async function readJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

async function collect<T>(stream: ReadableStream<T>) {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function rpc(
  fake: ReturnType<typeof createScriptedMcpServer>,
  message: JsonRpcMessage,
  sessionId?: string,
) {
  return fake.fetch("https://mcp.example.test/rpc", {
    method: "POST",
    headers: sessionId ? { "mcp-session-id": sessionId } : undefined,
    body: JSON.stringify(message),
  });
}

describe("protocol test fakes", () => {
  it("scripts fragmented LLM streams, mid-stream provider errors, and exhaustion", async () => {
    const fake = createScriptedLanguageModel([
      streamStep([
        ...textChunks("answer-1", ["hel", "lo"]),
        finishChunk("stop"),
      ]),
      requestErrorStep(new Error("provider overloaded")),
      streamStep(
        textChunks("answer-2", ["partial"]),
        { errorAfterChunks: 2, error: new Error("provider disconnected") },
      ),
    ]);

    const first = await fake.model.doStream({ prompt: [] } as never);
    await expect(collect(first.stream)).resolves.toEqual([
      expect.objectContaining({ type: "stream-start" }),
      expect.objectContaining({ type: "text-start", id: "answer-1" }),
      expect.objectContaining({ type: "text-delta", delta: "hel" }),
      expect.objectContaining({ type: "text-delta", delta: "lo" }),
      expect.objectContaining({ type: "text-end", id: "answer-1" }),
      expect.objectContaining({ type: "finish" }),
    ]);

    await expect(fake.model.doStream({ prompt: [] } as never)).rejects.toThrow(
      "provider overloaded",
    );

    const third = await fake.model.doStream({ prompt: [] } as never);
    const partial = await collect(third.stream);
    expect(partial).toHaveLength(3);
    expect(partial.at(-1)).toEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ message: "provider disconnected" }),
    }));
    expect(fake.model.doStreamCalls).toHaveLength(3);
    expect(fake.remainingSteps).toBe(0);
    expect(fake.assertExhausted).not.toThrow();

    await expect(fake.model.doStream({ prompt: [] } as never)).rejects.toThrow(
      "Scripted LLM exhausted after 3 calls",
    );
    expect(fake.callCount).toBe(4);
  });

  it("makes tool-call fragmentation and unfinished scripts observable", async () => {
    const chunks = toolCallChunks({
      id: "call-1",
      toolName: "mcp__demo__lookup",
      inputDeltas: ['{"query":', '"openma"}'],
    });
    expect(chunks.filter((chunk) => chunk.type === "tool-input-delta")).toEqual([
      expect.objectContaining({ delta: '{"query":' }),
      expect.objectContaining({ delta: '"openma"}' }),
    ]);
    expect(chunks.at(-1)).toMatchObject({
      type: "tool-call",
      input: '{"query":"openma"}',
    });

    const fake = createScriptedLanguageModel([
      streamStep(chunks),
      streamStep(textChunks("unused", ["never consumed"])),
    ]);
    await collect((await fake.model.doStream({ prompt: [] } as never)).stream);
    expect(fake.remainingSteps).toBe(1);
    expect(fake.assertExhausted).toThrow("1 unconsumed step");

    const empty = createScriptedLanguageModel([streamStep([])]);
    await expect(collect(
      (await empty.model.doStream({ prompt: [] } as never)).stream,
    )).resolves.toEqual([]);

    const disconnected = createScriptedLanguageModel([
      streamStep([], { errorAfterChunks: 0 }),
    ]);
    await expect(collect(
      (await disconnected.model.doStream({ prompt: [] } as never)).stream,
    )).resolves.toEqual([
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ message: "scripted LLM stream disconnected" }),
      }),
    ]);
  });

  it("runs a stateful MCP lifecycle with transient faults and session checks", async () => {
    const fake = createScriptedMcpServer({
      sessionId: "session-test-1",
      tools: [{
        name: "echo",
        description: "Echo a value",
        inputSchema: { type: "object" },
      }],
      methodPlans: {
        "tools/call": [
          { type: "http-error", status: 503, body: "retry me" },
          { type: "pass" },
        ],
      },
      callTool({ name, arguments: args }) {
        return {
          content: [{ type: "text", text: `${name}:${String(args?.value)}` }],
          structuredContent: { echoed: args?.value },
        };
      },
    });

    const initialize = await fake.fetch("https://mcp.example.test/rpc", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      } satisfies JsonRpcMessage),
    });
    expect(initialize.headers.get("mcp-session-id")).toBe("session-test-1");

    const list = await fake.fetch("https://mcp.example.test/rpc", {
      method: "POST",
      headers: { "mcp-session-id": "session-test-1" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(await readJson(list)).toMatchObject({
      result: { tools: [{ name: "echo" }] },
    });

    const call = () => fake.fetch("https://mcp.example.test/rpc", {
      method: "POST",
      headers: { "mcp-session-id": "session-test-1" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { value: "stable" } },
      }),
    });
    expect((await call()).status).toBe(503);
    expect(await readJson(await call())).toMatchObject({
      result: {
        content: [{ type: "text", text: "echo:stable" }],
        structuredContent: { echoed: "stable" },
      },
    });

    const badSession = await fake.fetch("https://mcp.example.test/rpc", {
      method: "POST",
      headers: { "mcp-session-id": "wrong-session" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    });
    expect(badSession.status).toBe(404);

    const closed = await fake.fetch("https://mcp.example.test/rpc", {
      method: "DELETE",
      headers: { "mcp-session-id": "session-test-1" },
    });
    expect(closed.status).toBe(200);
    expect(fake.state.counts).toMatchObject({
      initialize: 1,
      "tools/list": 2,
      "tools/call": 2,
      DELETE: 1,
    });
    expect(fake.state.invalidSessionCount).toBe(1);
    expect(fake.state.closed).toBe(true);
    expect(fake.assertPlanExhausted).not.toThrow();
  });

  it("scripts JSON-RPC errors and transport disconnects without hiding call order", async () => {
    const fake = createScriptedMcpServer({
      requireSession: false,
      methodPlans: {
        "tools/list": [
          { type: "json-rpc-error", code: -32001, message: "temporarily busy", data: { retry: true } },
          { type: "disconnect" },
          { type: "pass" },
        ],
      },
      tools: [{ name: "ready", inputSchema: { type: "object" } }],
    });

    expect(await readJson(await rpc(fake, {
      jsonrpc: "2.0", id: 1, method: "tools/list",
    }))).toMatchObject({
      error: { code: -32001, message: "temporarily busy", data: { retry: true } },
    });
    await expect(rpc(fake, {
      jsonrpc: "2.0", id: 2, method: "tools/list",
    })).rejects.toThrow("scripted MCP disconnect during tools/list");
    expect(await readJson(await rpc(fake, {
      jsonrpc: "2.0", id: 3, method: "tools/list",
    }))).toMatchObject({ result: { tools: [{ name: "ready" }] } });
    expect(fake.state.messages.map((message) => message.id)).toEqual([1, 2, 3]);
    expect(fake.assertPlanExhausted).not.toThrow();
  });

  it("models parse, handler-error, GET, and closed-session states", async () => {
    const fake = createScriptedMcpServer({
      sessionId: "lifecycle-1",
      methodPlans: { GET: [{ type: "http-error", status: 503 }] },
      callTool({ name }) {
        if (name === "explode") throw "non-error failure";
        throw new Error("handler failed");
      },
    });

    const malformed = await fake.fetch("https://mcp.example.test/rpc", {
      method: "POST",
      body: "not json",
    });
    expect(await readJson(malformed)).toMatchObject({ error: { code: -32700 } });

    expect((await fake.fetch("https://mcp.example.test/rpc", { method: "GET" })).status).toBe(404);
    expect((await fake.fetch("https://mcp.example.test/rpc", {
      method: "GET",
      headers: { "mcp-session-id": "lifecycle-1" },
    })).status).toBe(503);
    expect((await fake.fetch("https://mcp.example.test/rpc", {
      method: "GET",
      headers: { "mcp-session-id": "lifecycle-1" },
    })).status).toBe(405);

    const handlerError = await rpc(fake, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "fail" },
    }, "lifecycle-1");
    expect(await readJson(handlerError)).toMatchObject({
      error: { code: -32603, message: "handler failed" },
    });
    const nonError = await rpc(fake, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "explode" },
    }, "lifecycle-1");
    expect(await readJson(nonError)).toMatchObject({
      error: { code: -32603, message: "non-error failure" },
    });

    const closed = await fake.fetch("https://mcp.example.test/rpc", {
      method: "DELETE",
      headers: { "mcp-session-id": "wrong-session" },
    });
    expect(closed.status).toBe(404);
    expect(fake.state.invalidSessionCount).toBe(2);

    const validClose = await fake.fetch("https://mcp.example.test/rpc", {
      method: "DELETE",
      headers: { "mcp-session-id": "lifecycle-1" },
    });
    expect(validClose.status).toBe(200);
    expect((await rpc(fake, {
      jsonrpc: "2.0", id: 6, method: "tools/list",
    }, "lifecycle-1")).status).toBe(404);
    expect(fake.state.closedRequestCount).toBe(1);
  });

  it("returns protocol errors for unknown methods and tools instead of inventing results", async () => {
    const fake = createScriptedMcpServer({ requireSession: false });
    const unknownTool = await rpc(fake, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "missing", arguments: {} },
    });
    expect(await readJson(unknownTool)).toMatchObject({
      error: { code: -32601, message: "Unknown tool: missing" },
    });

    const unknownMethod = await rpc(fake, {
      jsonrpc: "2.0",
      id: 8,
      method: "resources/unsupported",
    });
    expect(await readJson(unknownMethod)).toMatchObject({
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("fails loudly when a fault plan was not exercised", () => {
    const fake = createScriptedMcpServer({
      methodPlans: {
        "tools/list": [{ type: "http-error", status: 503 }],
        "tools/call": [{ type: "disconnect" }, { type: "pass" }],
      },
    });
    expect(fake.assertPlanExhausted).toThrow(
      "Scripted MCP has unconsumed plans: tools/list:1, tools/call:2",
    );
  });
});
