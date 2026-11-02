import type { AgentTool } from "@earendil-works/pi-agent-core";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ToolCatalogEntry } from "./types";

const MCP_PREFIX = "mcp__";

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

export function mcpServerNameFromToolName(name: string): string | undefined {
  if (!isMcpToolName(name)) return undefined;
  const parts = name.split("__");
  return parts.length >= 3 ? parts[1] : undefined;
}

export function agentToolToCatalogEntry(tool: AgentTool): ToolCatalogEntry {
  const schema = tool.parameters as { properties?: Record<string, unknown> } | undefined;
  const parametersText = schema ? JSON.stringify(schema) : undefined;
  return {
    name: tool.name,
    description: tool.description ?? tool.label ?? tool.name,
    serverName: mcpServerNameFromToolName(tool.name),
    parametersText,
  };
}

export function buildToolCatalog(tools: AgentTool[]): ToolCatalogEntry[] {
  return tools
    .filter((tool) => tool.name !== "tool_search")
    .map(agentToolToCatalogEntry);
}

export function estimateToolDefinitionsTokens(tools: AgentTool[]): number {
  return tools.reduce((sum, tool) => {
    const schema = JSON.stringify(tool.parameters ?? {});
    const blob = `${tool.name}\n${tool.description ?? ""}\n${schema}`;
    return sum + estimateTextTokens(blob);
  }, 0);
}
