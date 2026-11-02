/**
 * The Matter MCP server: lists the OpenMatter tools of the caller's Session
 * and forwards each call to the kernel through the operation-call bridge
 * (the request itself registers the call; see `tool-bridge.ts`). It
 * holds no provider credentials; the kernel and the integration act with the
 * Bond the Turn runs under.
 *
 * Streamable HTTP with JSON responses only (no server-initiated stream), which
 * MCP allows: POST carries one JSON-RPC message or a batch; GET is refused.
 */

import {
  mcpToolName,
  ToolCallError,
  type JsonValue,
  type OperationCallBridge,
} from "./tool-bridge.js";
import type { SessionTokenStore } from "./session-tokens.js";

export const MCP_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export interface MatterMcpServerOptions {
  readonly bridge: OperationCallBridge;
  readonly tokens: SessionTokenStore;
  readonly name?: string;
  readonly version?: string;
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      error: { code: number; message: string };
    };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rpcError = (
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Operation-call results the Agent should treat as a failed call. A
 * `conflict` is not an error: it shows the Agent the newer messages. */
const ERROR_STATUSES = new Set(["refused", "failed", "uncertain"]);

const toolResult = (text: string, isError: boolean) => ({
  content: [{ type: "text", text }],
  isError,
});

export const createMatterMcpHandler = (options: MatterMcpServerOptions) => {
  const serverInfo = {
    name: options.name ?? "openmatter",
    version: options.version ?? "0.1.0",
  };

  const handle = async (
    sessionId: string,
    message: JsonRpcRequest,
    signal: AbortSignal,
  ): Promise<JsonRpcResponse | undefined> => {
    const id = message.id ?? null;
    // Notifications get no response.
    if (message.id === undefined) return undefined;
    switch (message.method) {
      case "initialize": {
        const requested = message.params?.protocolVersion;
        const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(
          requested as (typeof MCP_PROTOCOL_VERSIONS)[number],
        )
          ? requested
          : MCP_PROTOCOL_VERSIONS[0];
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: (await options.bridge.tools(sessionId)).map((tool) => ({
              name: mcpToolName(tool.name),
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
        };
      case "tools/call": {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        if (typeof name !== "string" || !isRecord(args)) {
          return rpcError(id, INVALID_PARAMS, "tools/call needs a name and object arguments");
        }
        const known = (await options.bridge.tools(sessionId)).some((tool) => mcpToolName(tool.name) === name);
        if (!known) {
          return rpcError(id, INVALID_PARAMS, `Unknown tool ${name}`);
        }
        try {
          const outcome = await options.bridge.call(sessionId, name, args as JsonValue, signal);
          if (!outcome.ok) {
            return {
              jsonrpc: "2.0",
              id,
              result: toolResult(JSON.stringify(outcome.error), true),
            };
          }
          const status = isRecord(outcome.result) ? outcome.result.status : undefined;
          return {
            jsonrpc: "2.0",
            id,
            result: toolResult(
              JSON.stringify(outcome.result as JsonValue),
              typeof status === "string" && ERROR_STATUSES.has(status),
            ),
          };
        } catch (error) {
          if (error instanceof ToolCallError) {
            return { jsonrpc: "2.0", id, result: toolResult(error.message, true) };
          }
          throw error;
        }
      }
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    }
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    const sessionId = match?.[1] === undefined ? null : await options.tokens.resolve(match[1]);
    if (sessionId === null) {
      return Response.json(
        { error: "unauthorized" },
        { status: 401, headers: { "www-authenticate": "Bearer" } },
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(rpcError(null, PARSE_ERROR, "Parse error"), { status: 400 });
    }
    const batch = Array.isArray(body);
    const messages = batch ? (body as unknown[]) : [body];
    if (messages.length === 0) {
      return Response.json(rpcError(null, INVALID_REQUEST, "Empty batch"), { status: 400 });
    }
    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      if (
        !isRecord(message) ||
        message.jsonrpc !== "2.0" ||
        typeof message.method !== "string"
      ) {
        // A JSON-RPC response from the client (we never ask), or garbage.
        if (isRecord(message) && message.jsonrpc === "2.0" && message.method === undefined) {
          continue;
        }
        responses.push(rpcError(null, INVALID_REQUEST, "Invalid Request"));
        continue;
      }
      const response = await handle(sessionId, message as unknown as JsonRpcRequest, request.signal);
      if (response !== undefined) responses.push(response);
    }
    if (responses.length === 0) return new Response(null, { status: 202 });
    return Response.json(batch ? responses : responses[0]);
  };
};
