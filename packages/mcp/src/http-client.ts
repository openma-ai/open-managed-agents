import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
  type VersionNegotiationMode,
} from "@modelcontextprotocol/client";
import type {
  McpClientPort,
  McpRequestOptions,
  McpToolDefinition,
  McpToolResult,
} from "./port";

export type McpVersionNegotiation =
  | "legacy"
  | "auto"
  | { pin: string };

export interface HttpMcpClientOptions {
  url: string | URL;
  clientInfo: { name: string; version: string };
  /** Platform-owned network Port: global fetch, a service binding, or a proxy. */
  fetch?: typeof globalThis.fetch;
  requestInit?: RequestInit;
  /** Defaults to auto: use v2 discovery with an official legacy fallback. */
  versionNegotiation?: McpVersionNegotiation;
  /** Applied to the initialization handshake. Per-call values may override it. */
  timeoutMs?: number;
  /** Maximum wait for the optional remote DELETE before local close. Default: 5s. */
  closeTimeoutMs?: number;
  /** Principal boundary for private MCP response-cache entries. */
  cachePartition?: string;
}

function requestOptions(
  options: McpRequestOptions | undefined,
  defaultTimeoutMs: number | undefined,
) {
  return {
    signal: options?.signal,
    timeout: options?.timeoutMs ?? defaultTimeoutMs,
  };
}

/**
 * Official Streamable HTTP adapter. The OpenMA surface stays a small Port;
 * protocol negotiation, sessions, SSE, pagination and validation remain the
 * responsibility of the MCP SDK.
 */
export async function connectHttpMcpClient(
  options: HttpMcpClientOptions,
): Promise<McpClientPort> {
  const mode: VersionNegotiationMode = options.versionNegotiation ?? "auto";
  const client = new Client(options.clientInfo, {
    versionNegotiation: { mode },
    cachePartition: options.cachePartition,
  });
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    fetch: options.fetch as FetchLike | undefined,
    requestInit: options.requestInit,
  });

  try {
    await client.connect(transport, { timeout: options.timeoutMs });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    async listTools(callOptions) {
      const result = await client.listTools(
        undefined,
        requestOptions(callOptions, options.timeoutMs),
      );
      return result.tools as unknown as McpToolDefinition[];
    },

    async callTool(input, callOptions) {
      const result = await client.callTool(
        { name: input.name, arguments: input.arguments },
        requestOptions(callOptions, options.timeoutMs),
      );
      return result as unknown as McpToolResult;
    },

    async close() {
      if (closed) return;
      closed = true;
      const termination = transport.terminateSession();
      // A transport abort normally rejects the pending fetch. Keep a handler
      // attached for platforms/custom fetches that settle after our timeout.
      void termination.catch(() => undefined);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          termination,
          new Promise<void>((resolve) => {
            timeoutHandle = setTimeout(resolve, options.closeTimeoutMs ?? 5_000);
          }),
        ]).catch(() => undefined);
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        await client.close();
      }
    },
  };
}
