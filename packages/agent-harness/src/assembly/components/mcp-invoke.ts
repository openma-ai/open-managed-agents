import { Type, validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { MCP_INVOKE_TOOL_NAME, type McpInvokeArgs } from "../../tool-proxy";

/**
 * The stable entry point for deferred MCP tools when the model cannot declare tools
 * mid-conversation. `tool_search` returns each match's schema; the model then calls it through
 * `mcp_invoke`, so the tool list sent to the model never changes.
 *
 * The call is delegated to the target tool's own `execute`, so everything attached to it (MCP
 * transport, result conversion, the pending-confirmation path of `always_ask` tools) applies
 * exactly as for a direct call.
 */
export function createMcpInvokeTool(options: {
  /** The tool `mcp_invoke` may call under this name, or undefined when it is not reachable. */
  resolveTarget: (toolName: string) => AgentTool | undefined;
}): AgentTool {
  return {
    name: MCP_INVOKE_TOOL_NAME,
    label: MCP_INVOKE_TOOL_NAME,
    description:
      "Call a deferred MCP tool found with tool_search. Pass the exact tool name from the search "
      + "result and arguments matching its JSON schema. Use tool_search first if you do not know a "
      + "tool's name or schema.",
    parameters: Type.Object({
      tool_name: Type.String({ description: "Exact tool name returned by tool_search" }),
      arguments: Type.Optional(
        Type.Object({}, {
          additionalProperties: true,
          description: "Arguments for the tool, matching its JSON schema",
        }),
      ),
    }),
    execute: async (toolCallId, params, signal, onUpdate) => {
      const { tool_name: toolName, arguments: rawArgs } = params as McpInvokeArgs;
      const target = options.resolveTarget(toolName);
      if (!target) {
        throw new Error(
          `Unknown tool "${toolName}" for ${MCP_INVOKE_TOOL_NAME}. `
            + "Use tool_search to find the exact name and schema.",
        );
      }
      const args = validateToolArguments(target, {
        type: "toolCall",
        id: toolCallId,
        name: target.name,
        arguments: (rawArgs ?? {}) as JsonObject,
      });
      return target.execute(toolCallId, args, signal, onUpdate);
    },
  };
}
