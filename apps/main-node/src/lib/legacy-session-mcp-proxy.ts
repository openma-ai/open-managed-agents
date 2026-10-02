import type { CredentialService } from "@open-managed-agents/credentials-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import {
  createNodeMcpProxyBinding,
  type NodeMcpProxyBinding,
} from "./http-mcp-proxy.js";

/**
 * MCP proxy for the legacy Node harness. Integration sessions store their
 * servers on `agent_snapshot`; resume refreshes that row, and the next turn
 * reads it here so a published URL change is what the upstream call hits.
 */
export function createLegacySessionMcpProxy(deps: {
  sessions: SessionService;
  credentials: CredentialService;
}): NodeMcpProxyBinding {
  return createNodeMcpProxyBinding({
    resolveTarget: async ({ tenantId, sessionId, serverName }) => {
      const session = await deps.sessions.get({ tenantId, sessionId }).catch(() => null);
      if (!session || session.archived_at) return null;
      const server = session.agent_snapshot?.mcp_servers?.find(
        (candidate) => candidate.name === serverName && "url" in candidate,
      );
      if (!server || !("url" in server) || !server.url) return null;
      const inline = server.authorization_token;
      if (inline) return { upstreamUrl: server.url, accessToken: inline };
      const vaultIds = session.vault_ids ?? [];
      if (vaultIds.length === 0) return null;
      const groups = await deps.credentials.listByVaults({ tenantId, vaultIds });
      for (const group of groups) {
        for (const credential of group.credentials) {
          if (credential.archived_at !== null) continue;
          const auth = credential.auth as {
            type?: string;
            mcp_server_url?: string;
            bearer_token?: string;
            token?: string;
            access_token?: string;
          };
          if (auth.mcp_server_url !== server.url) continue;
          const accessToken = auth.bearer_token ?? auth.token ?? auth.access_token;
          if (!accessToken) continue;
          return { upstreamUrl: server.url, accessToken };
        }
      }
      return null;
    },
  });
}
