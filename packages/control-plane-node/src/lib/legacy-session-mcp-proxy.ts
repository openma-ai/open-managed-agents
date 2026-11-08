import type { CredentialService } from "@open-managed-agents/credentials-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import {
  createMcpProxyBinding,
  type McpProxyBinding,
  type McpProxyPorts,
} from "@open-managed-agents/http-routes/proxy";

/**
 * MCP proxy for the legacy Node harness. Integration sessions store their
 * servers on `agent_snapshot`; resume refreshes that row, and the next turn
 * reads it here so a published URL change is what the upstream call hits.
 * The harness runs only legacy `/v1/oma` Sessions, so no v1 Session or
 * managed Vault is ever looked up.
 */
export function createLegacySessionMcpProxy(deps: {
  sessions: SessionService;
  credentials: CredentialService;
  log: McpProxyPorts["log"];
}): McpProxyBinding {
  const ports: McpProxyPorts = {
    sessions: { managed: { find: async () => null }, legacy: deps.sessions },
    legacyCredentials: deps.credentials,
    managedCredentials: () => {
      throw new Error("the legacy Node harness has no managed Vault credentials");
    },
    log: deps.log,
  };
  return createMcpProxyBinding(() => ports);
}
