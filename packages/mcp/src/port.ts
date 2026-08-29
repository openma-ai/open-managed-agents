export type McpJsonObject = Record<string, unknown>;

/** Protocol-shaped tool definition without leaking an SDK implementation type. */
export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema: McpJsonObject;
  outputSchema?: McpJsonObject;
  annotations?: McpJsonObject;
  icons?: Array<McpJsonObject>;
  _meta?: McpJsonObject;
  [key: string]: unknown;
}

/**
 * MCP content is intentionally open: new protocol block kinds pass through
 * this boundary instead of requiring an OpenMA release before they can be
 * transported.
 */
export interface McpContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: McpJsonObject;
  [key: string]: unknown;
}

export interface McpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Runtime-neutral capability consumed by harness/tool adapters. */
export interface McpClientPort {
  listTools(options?: McpRequestOptions): Promise<McpToolDefinition[]>;
  callTool(
    input: { name: string; arguments?: McpJsonObject },
    options?: McpRequestOptions,
  ): Promise<McpToolResult>;
  close(): Promise<void>;
}
