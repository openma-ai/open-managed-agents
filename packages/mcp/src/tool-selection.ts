/** The tool-selection fields shared by host harnesses and the MCP gateway. */
export interface McpToolSelectionConfig {
  tools: readonly {
    type: string;
    mcp_server_name?: string;
    default_config?: { enabled?: boolean };
    configs?: readonly { name: string; enabled?: boolean }[];
  }[];
}

/** Preserve Agent toolset precedence: per-tool, server default, then enabled. */
export function isMcpToolEnabled(
  agentConfig: McpToolSelectionConfig,
  serverName: string,
  remoteToolName: string,
): boolean {
  const toolset = agentConfig.tools.find(tool =>
    tool.type === "mcp_toolset" && tool.mcp_server_name === serverName);
  const configured = toolset?.configs?.find(candidate => candidate.name === remoteToolName);
  return configured?.enabled ?? toolset?.default_config?.enabled ?? true;
}
