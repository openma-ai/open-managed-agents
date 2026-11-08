/**
 * Wire contract of `mcp_invoke`, the stable proxy through which the model calls deferred MCP tools
 * when the model cannot load tool definitions mid-conversation.
 *
 * The assembly layer produces these calls and the runtime consumes them (tool confirmation replays
 * a pending call by tool name). Both depend on this module, not on each other.
 */

export const MCP_INVOKE_TOOL_NAME = "mcp_invoke";

export interface McpInvokeArgs {
  tool_name: string;
  arguments?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve the tool a call actually targets. `mcp_invoke` calls resolve to the proxied tool and its
 * arguments; every other call, and a malformed proxy call, is returned unchanged.
 */
export function resolveProxiedToolCall(
  toolName: string,
  args: unknown,
): { toolName: string; args: unknown } {
  if (toolName !== MCP_INVOKE_TOOL_NAME || !isRecord(args)) return { toolName, args };
  const target = args.tool_name;
  if (typeof target !== "string" || target.length === 0) return { toolName, args };
  return { toolName: target, args: isRecord(args.arguments) ? args.arguments : {} };
}
