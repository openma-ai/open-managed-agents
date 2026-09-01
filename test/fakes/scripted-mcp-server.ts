export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

export interface FakeMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

export type McpMethodPlan =
  | { type: "pass" }
  | { type: "http-error"; status: number; body?: string }
  | { type: "json-rpc-error"; code: number; message: string; data?: unknown }
  | { type: "disconnect"; error?: Error }
  | { type: "hang" };

export interface ScriptedMcpServerOptions {
  sessionId?: string;
  serverInfo?: { name: string; version: string };
  tools?: FakeMcpTool[];
  requireSession?: boolean;
  methodPlans?: Record<string, McpMethodPlan[]>;
  callTool?: (input: {
    name: string;
    arguments?: Record<string, unknown>;
    message: JsonRpcMessage;
    request: Request;
  }) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface ScriptedMcpState {
  requests: Request[];
  messages: JsonRpcMessage[];
  counts: Record<string, number>;
  invalidSessionCount: number;
  closedRequestCount: number;
  closed: boolean;
}

function jsonRpcResult(
  id: string | number,
  result: Record<string, unknown>,
  headers?: HeadersInit,
) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function jsonRpcError(
  id: string | number | undefined,
  code: number,
  message: string,
  data?: unknown,
) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function createScriptedMcpServer(options: ScriptedMcpServerOptions = {}) {
  const sessionId = options.sessionId ?? "scripted-mcp-session";
  const requireSession = options.requireSession ?? true;
  const methodPlans = Object.fromEntries(
    Object.entries(options.methodPlans ?? {}).map(([method, plans]) => [method, [...plans]]),
  ) as Record<string, McpMethodPlan[]>;
  const state: ScriptedMcpState = {
    requests: [],
    messages: [],
    counts: {},
    invalidSessionCount: 0,
    closedRequestCount: 0,
    closed: false,
  };

  function count(method: string) {
    state.counts[method] = (state.counts[method] ?? 0) + 1;
  }

  async function plannedResponse(
    method: string,
    message?: JsonRpcMessage,
  ): Promise<Response | undefined> {
    const plan = methodPlans[method]?.shift();
    if (!plan || plan.type === "pass") return undefined;
    if (plan.type === "http-error") {
      return new Response(plan.body ?? `scripted ${plan.status}`, { status: plan.status });
    }
    if (plan.type === "json-rpc-error") {
      return jsonRpcError(message?.id, plan.code, plan.message, plan.data);
    }
    if (plan.type === "disconnect") {
      throw plan.error ?? new TypeError(`scripted MCP disconnect during ${method}`);
    }
    return new Promise<Response>(() => undefined);
  }

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    state.requests.push(request.clone());

    if (state.closed) {
      state.closedRequestCount += 1;
      return new Response("MCP session is closed", { status: 404 });
    }

    if (request.method === "DELETE") {
      count("DELETE");
      if (requireSession && request.headers.get("mcp-session-id") !== sessionId) {
        state.invalidSessionCount += 1;
        return new Response("unknown MCP session", { status: 404 });
      }
      const planned = await plannedResponse("DELETE");
      if (planned) return planned;
      state.closed = true;
      return new Response(null, { status: 200 });
    }

    if (request.method === "GET") {
      count("GET");
      if (requireSession && request.headers.get("mcp-session-id") !== sessionId) {
        state.invalidSessionCount += 1;
        return new Response("unknown MCP session", { status: 404 });
      }
      const planned = await plannedResponse("GET");
      return planned ?? new Response(null, { status: 405 });
    }

    let message: JsonRpcMessage;
    try {
      message = await request.json() as JsonRpcMessage;
    } catch {
      return jsonRpcError(undefined, -32700, "Parse error");
    }
    state.messages.push(message);
    const method = message.method ?? "<missing>";
    count(method);

    const isPreSession = method === "initialize" || method === "server/discover";
    if (
      requireSession
      && !isPreSession
      && request.headers.get("mcp-session-id") !== sessionId
    ) {
      state.invalidSessionCount += 1;
      return new Response("unknown MCP session", { status: 404 });
    }

    const planned = await plannedResponse(method, message);
    if (planned) return planned;

    if (method === "server/discover") {
      return jsonRpcError(message.id, -32601, "Method not found");
    }
    if (method === "initialize") {
      return jsonRpcResult(message.id!, {
        protocolVersion: String(message.params?.protocolVersion ?? "2025-06-18"),
        capabilities: { tools: {} },
        serverInfo: options.serverInfo ?? { name: "scripted-mcp", version: "1.0.0" },
      }, { "mcp-session-id": sessionId });
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (method === "tools/list") {
      return jsonRpcResult(message.id!, { tools: options.tools ?? [] });
    }
    if (method === "tools/call") {
      const params = message.params ?? {};
      const name = String(params.name ?? "");
      const args = params.arguments as Record<string, unknown> | undefined;
      if (!options.callTool) {
        return jsonRpcError(message.id, -32601, `Unknown tool: ${name}`);
      }
      try {
        return jsonRpcResult(message.id!, await options.callTool({
          name,
          arguments: args,
          message,
          request,
        }));
      } catch (error) {
        return jsonRpcError(
          message.id,
          -32603,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return jsonRpcError(message.id, -32601, "Method not found");
  };

  return {
    fetch,
    state,
    assertPlanExhausted() {
      const pending = Object.entries(methodPlans)
        .filter(([, plans]) => plans.length > 0)
        .map(([method, plans]) => `${method}:${plans.length}`);
      if (pending.length > 0) {
        throw new Error(`Scripted MCP has unconsumed plans: ${pending.join(", ")}`);
      }
    },
  };
}
