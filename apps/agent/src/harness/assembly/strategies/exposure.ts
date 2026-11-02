import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import type { ToolAssemblyConfig } from "../config";
import { estimateToolDefinitionsTokens, isMcpToolName } from "../catalog";
import { MCP_INVOKE_TOOL_NAME } from "../../tool-proxy";

/**
 * How the model reaches deferred MCP tools once `tool_search` finds them.
 *
 * - `direct`: found tools are declared for the next model call and called by name. Each load changes
 *   the tool list, so this is used only when the model can declare tools mid-conversation.
 * - `proxy`: the tool list never changes; the model calls found tools through `mcp_invoke`.
 */
export type DeferredToolInvocation = "direct" | "proxy";

export interface ToolExposurePlan {
  /** Whether deferred MCP tools are hidden behind `tool_search`. */
  toolSearchEnabled: boolean;
  /** How deferred tools are called; meaningful only when `toolSearchEnabled`. */
  invocation: DeferredToolInvocation;
  /** Tools passed to the model for this request. */
  exposed: AgentTool[];
  /** MCP tools the model must reach through `tool_search` (names only when search is on). */
  deferredNames: string[];
}

export interface ToolExposureStrategy {
  plan(input: {
    allTools: AgentTool[];
    loadedToolNames: ReadonlySet<string>;
    config: ToolAssemblyConfig;
    model: Model<Api>;
    /** Enable `tool_search` even when no MCP tools are deferred (e.g. budgeted skills). */
    forceToolSearch?: boolean;
    /**
     * Whether the model can declare tools mid-conversation. When false, deferred tools are called
     * through `mcp_invoke` and the exposed tool list stays fixed. Defaults to true.
     */
    nativeToolLoading?: boolean;
  }): ToolExposurePlan;
}

const ASSEMBLY_TOOL_NAMES = new Set(["tool_search", MCP_INVOKE_TOOL_NAME]);

function isResidentTool(name: string, alwaysLoad: ReadonlySet<string>): boolean {
  if (ASSEMBLY_TOOL_NAMES.has(name)) return false;
  if (!isMcpToolName(name)) return true;
  return alwaysLoad.has(name);
}

export function createToolExposureStrategy(): ToolExposureStrategy {
  return {
    plan({ allTools, loadedToolNames, config, model, forceToolSearch = false, nativeToolLoading = true }) {
      const byName = new Map(allTools.map((tool) => [tool.name, tool]));
      const mcpTools = allTools.filter((tool) => isMcpToolName(tool.name));
      const deferredCandidates = mcpTools.filter(
        (tool) => !isResidentTool(tool.name, config.alwaysLoad),
      );
      const invocation: DeferredToolInvocation = nativeToolLoading ? "direct" : "proxy";

      let toolSearchEnabled = forceToolSearch;
      if (!toolSearchEnabled) {
        if (config.mode === "on") {
          toolSearchEnabled = deferredCandidates.length > 0;
        } else if (config.mode === "auto" && deferredCandidates.length > 0) {
          const budgetTokens = Math.floor(model.contextWindow * config.autoThresholdFraction);
          toolSearchEnabled = estimateToolDefinitionsTokens(deferredCandidates) > budgetTokens;
        }
      }

      if (!toolSearchEnabled) {
        return {
          toolSearchEnabled: false,
          invocation,
          exposed: allTools.filter((t) => !ASSEMBLY_TOOL_NAMES.has(t.name)),
          deferredNames: [],
        };
      }

      const exposed: AgentTool[] = [];
      for (const tool of allTools) {
        if (ASSEMBLY_TOOL_NAMES.has(tool.name)) continue;
        if (isResidentTool(tool.name, config.alwaysLoad)) {
          exposed.push(tool);
          continue;
        }
        // Proxy mode never declares deferred tools, so loading cannot change the tool list.
        if (invocation === "direct" && loadedToolNames.has(tool.name)) {
          exposed.push(tool);
        }
      }

      const deferredNames = deferredCandidates
        .map((tool) => tool.name)
        .filter((name) => invocation === "proxy" || !loadedToolNames.has(name));

      const searchTool = byName.get("tool_search");
      if (searchTool) exposed.push(searchTool);
      if (invocation === "proxy" && deferredCandidates.length > 0) {
        const invokeTool = byName.get(MCP_INVOKE_TOOL_NAME);
        if (invokeTool) exposed.push(invokeTool);
      }

      return { toolSearchEnabled: true, invocation, exposed, deferredNames };
    },
  };
}
