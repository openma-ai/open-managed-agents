/** Validate persisted inputs as well as typed configurations before any child starts. */
export function rejectLegacyMcpSse(servers: readonly object[] | undefined): void {
  if (servers?.some(server => "type" in server && server.type === "sse")) {
    throw new Error("MCP_SSE_UNSUPPORTED: Legacy MCP SSE transport is unsupported; use streamable HTTP or stdio.");
  }
}
