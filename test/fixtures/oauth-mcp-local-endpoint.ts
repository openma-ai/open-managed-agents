/** Host and control contract for the local OAuth/MCP test server. No Node APIs. */

declare const __OMA_OAUTH_MCP_TEST_PORT__: number | undefined;

/** The root vitest config defines this from OMA_OAUTH_MCP_TEST_PORT, so
 * worktrees running the suite at the same time can use different ports. */
export const OAUTH_MCP_TEST_PORT =
  typeof __OMA_OAUTH_MCP_TEST_PORT__ === "number" ? __OMA_OAUTH_MCP_TEST_PORT__ : 47651;
export const OAUTH_MCP_TEST_ORIGIN = `http://127.0.0.1:${OAUTH_MCP_TEST_PORT}`;

export interface OauthMcpTestControl {
  accessToken: string;
  refreshToken: string;
  clientId?: string | null;
  clientSecret?: string | null;
  mcp?: "match" | "unavailable" | "forbidden" | "redirect";
  token?: "rotate" | "invalid_grant" | "unavailable";
  resource?: string | null;
  scope?: string | null;
}

export interface OauthMcpTestMeta {
  issuedCount: number;
  mcpRequests: number;
  tokenRequests: number;
  sinkSawAuthorization: boolean;
  basicSecretMatched: boolean;
  postSecretMatched: boolean;
  resourceMatched: boolean;
  scopeMatched: boolean;
  clientIdMatched: boolean;
}

export async function resetOauthMcpTestServer(
  origin: string,
  control: OauthMcpTestControl,
): Promise<void> {
  const response = await fetch(`${origin}/__reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(control),
  });
  if (!response.ok) {
    throw new Error(`oauth test server reset failed: ${response.status}`);
  }
  await response.arrayBuffer();
}

export async function invalidateOauthMcpAccessToken(origin: string): Promise<void> {
  const response = await fetch(`${origin}/__invalidate-access`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`oauth test server invalidate failed: ${response.status}`);
  }
  await response.arrayBuffer();
}

export async function reserveOauthMcpClosedPort(origin: string): Promise<number> {
  const response = await fetch(`${origin}/__closed-port`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`oauth test server closed-port failed: ${response.status}`);
  }
  const body = (await response.json()) as { port?: number };
  if (typeof body.port !== "number" || body.port <= 0) {
    throw new Error("oauth test server closed-port returned no port");
  }
  return body.port;
}

export async function readOauthMcpTestMeta(origin: string): Promise<OauthMcpTestMeta> {
  const response = await fetch(`${origin}/__meta`);
  if (!response.ok) {
    throw new Error(`oauth test server meta failed: ${response.status}`);
  }
  return (await response.json()) as OauthMcpTestMeta;
}
