import { startOauthMcpTestServer, type OauthMcpTestServer } from "../fixtures/oauth-mcp-local-server";
import { OAUTH_MCP_TEST_PORT } from "../fixtures/oauth-mcp-local-endpoint";

let server: OauthMcpTestServer | undefined;

export async function setup(): Promise<void> {
  // Global setup is not transformed with the config's `define`; the config
  // exports the same port through the environment (see vitest.config.ts).
  const port = Number(process.env.OMA_OAUTH_MCP_TEST_PORT ?? OAUTH_MCP_TEST_PORT);
  server = await startOauthMcpTestServer({ port });
}

export async function teardown(): Promise<void> {
  await server?.close();
}
