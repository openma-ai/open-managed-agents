export interface McpConnectTransport {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  openBrowser(url: string): void;
  print(text: string): void;
  sleep(ms: number): Promise<void>;
}

/** No local callback listener or browser API key. Provider redirects to the
 * service's registered callback; this process claims only the credential ID. */
export async function connectMcpOAuth(io: McpConnectTransport, input: { vaultId: string; serverUrl: string; clientId?: string; clientSecret?: string }): Promise<string> {
  const flow = await io.request<{ authorization_url: string; flow_id: string; claim_token: string; expires_at: string; interval_seconds: number }>("/v1/oma/oauth/cli/authorize", { method: "POST", body: JSON.stringify({ vault_id: input.vaultId, mcp_server_url: input.serverUrl, ...(input.clientId && { client_id: input.clientId }), ...(input.clientSecret && { client_secret: input.clientSecret }) }) });
  const expires = Math.min(Date.parse(flow.expires_at), Date.now() + 600_000);
  if (!Number.isFinite(expires)) throw new Error("Invalid OAuth flow expiry");
  const url = new URL(flow.authorization_url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid OAuth authorization URL");
  io.print(`Open this URL to authorize:\n  ${url.toString()}`);
  try { io.openBrowser(url.toString()); } catch { /* Printed URL supports headless shells. */ }
  while (Date.now() < expires) {
    const result = await io.request<{ status: "pending" | "failed" | "ready"; credential_id?: string }>("/v1/oma/oauth/cli/result", { method: "POST", body: JSON.stringify({ flow_id: flow.flow_id, claim_token: flow.claim_token }) });
    if (result.status === "ready" && result.credential_id) {
      io.print(`Connected (${result.credential_id}).`);
      return result.credential_id;
    }
    if (result.status !== "pending") throw new Error("MCP OAuth authorization failed. Start a new connection to retry.");
    await io.sleep(Math.max(1, Math.min(flow.interval_seconds || 2, 10)) * 1000);
  }
  throw new Error("MCP OAuth authorization timed out. Start a new connection to retry.");
}
