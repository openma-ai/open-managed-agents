import type { ContentBlock, SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext } from "./interface";
import { ALL_TOOLS } from "./tools";
import { MCP_INVOKE_TOOL_NAME, resolveProxiedToolCall } from "./tool-proxy";

const BUILTIN_TOOLS = new Set(ALL_TOOLS);

/** MCP calls use their own event family; the proxy tool itself is built-in. */
export const isMcpTool = (name: string): boolean =>
  name.startsWith("mcp_") && name !== MCP_INVOKE_TOOL_NAME;

export const isBuiltinTool = (name: string): boolean =>
  BUILTIN_TOOLS.has(name)
  || isMcpTool(name)
  || name === MCP_INVOKE_TOOL_NAME
  || name.startsWith("call_agent_");

function extractMcpServerName(toolName: string): string {
  if (toolName.startsWith("mcp__")) {
    const withoutPrefix = toolName.slice("mcp__".length);
    const separator = withoutPrefix.indexOf("__");
    return separator >= 0 ? withoutPrefix.slice(0, separator) : withoutPrefix;
  }
  const withoutPrefix = toolName.slice(4);
  if (withoutPrefix.endsWith("_list_tools")) {
    return withoutPrefix.slice(0, withoutPrefix.length - "_list_tools".length);
  }
  const lastUnderscore = withoutPrefix.lastIndexOf("_");
  return lastUnderscore > 0 ? withoutPrefix.slice(0, lastUnderscore) : withoutPrefix;
}

/** Shared wire projection for Pi and ACP tool-call events. */
export async function emitHarnessToolUseFromCall(
  runtime: HarnessContext["runtime"],
  tools: Record<string, any>,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<void> {
  const resolved = resolveProxiedToolCall(toolName, input);
  const target = tools[resolved.toolName] as {
    execute?: unknown;
    metadata?: { openmaPermission?: {
      policy?: string;
      bindEventSink?: (broadcast: (event: SessionEvent) => void) => void;
      bindHistory?: (getHistory: () => SessionEvent[]) => void;
      evaluate?: (id: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ decision: "allow" | "deny" | "ask"; reason?: string }>;
    } };
  } | undefined;
  const permission = target?.metadata?.openmaPermission;
  permission?.bindEventSink?.(runtime.broadcast);
  permission?.bindHistory?.(() => runtime.history.getEvents());
  const evaluated = permission?.policy === "auto" && permission.evaluate
    ? await permission.evaluate(
      toolCallId,
      resolved.args && typeof resolved.args === "object" && !Array.isArray(resolved.args)
        ? resolved.args as Record<string, unknown>
        : {},
      runtime.abortSignal,
    )
    : undefined;
  if (isMcpTool(toolName)) {
    const registeredServerName = tools[toolName]?.metadata?.serverName;
    runtime.broadcast({
      type: "agent.mcp_tool_use",
      id: toolCallId,
      mcp_server_name:
        typeof registeredServerName === "string" && registeredServerName.length > 0
          ? registeredServerName
          : extractMcpServerName(toolName),
      name: toolName,
      input,
      ...(evaluated ? { evaluated_permission: evaluated.decision } : {}),
    });
    return;
  }
  const event: SessionEvent = isBuiltinTool(toolName) || tools[toolName]?.metadata?.openmaBuiltin === true
    ? {
        type: "agent.tool_use",
        id: toolCallId,
        name: toolName,
        input,
        ...(evaluated
          ? { evaluated_permission: evaluated.decision }
          : (tools[resolved.toolName]?.execute ? {} : { evaluated_permission: "ask" as const })),
      }
    : {
        type: "agent.custom_tool_use",
        id: toolCallId,
        name: toolName,
        input,
      } as SessionEvent;
  runtime.broadcast(event);
}

