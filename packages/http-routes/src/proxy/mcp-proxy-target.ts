import type { ManagedCredentialTarget } from "@open-managed-agents/managed-credential-resolver";
import type { LegacyCredentialRefresh } from "./legacy-credential-refresh";
import type { McpProxyPorts } from "./mcp-proxy-ports";
import { findProxySession, selectProxyAgent, type ProxyAgentIdentity } from "./proxy-session";

/** Where one MCP request goes and which credential rides with it. */
export type McpProxyTarget = AnonymousMcpTarget | BearerMcpTarget | ManagedMcpTarget;

/** No Vaults attached and no inline token: sent without a bearer (#527). */
export interface AnonymousMcpTarget {
  upstreamUrl: string;
  upstreamToken: null;
}

/** An inline `authorization_token` or a legacy Vault credential. */
export interface BearerMcpTarget {
  upstreamUrl: string;
  upstreamToken: string;
  refresh?: LegacyCredentialRefresh;
}

/** A managed (v1) Vault credential; the shared resolver owns its refresh. */
export interface ManagedMcpTarget {
  upstreamUrl: string;
  upstreamToken: string;
  managed: ManagedCredentialTarget;
}

export interface McpProxyTargetRequest {
  workspaceId: string;
  sessionId: string;
  serverName: string;
  /** A pinned roster member; the root agent when absent. */
  agent?: ProxyAgentIdentity;
}

/**
 * The upstream and credential for (Session, server), or null when the
 * Session is gone or archived, the server is not on that agent's roster, or a
 * Session with Vaults has no matching credential. A credential-store failure
 * propagates: it is never read as "no credential", so nothing is forwarded
 * without the bearer the Session's Vaults would have supplied.
 */
export async function resolveMcpProxyTarget(
  ports: Pick<McpProxyPorts, "sessions" | "legacyCredentials" | "managedCredentials">,
  request: McpProxyTargetRequest,
): Promise<McpProxyTarget | null> {
  const session = await findProxySession(ports.sessions, request);
  if (session === null) return null;
  const server = selectProxyAgent(session, request.agent)?.mcpServers
    .find((candidate) => candidate.name === request.serverName);
  if (server === undefined || server.url === null) return null;
  if (server.authorizationToken !== null) {
    return { upstreamUrl: server.url, upstreamToken: server.authorizationToken };
  }
  if (session.vaultIds.length === 0) return { upstreamUrl: server.url, upstreamToken: null };
  const scope = { workspaceId: request.workspaceId, sessionId: request.sessionId, vaultIds: session.vaultIds };
  if (session.kind === "managed") {
    const managed = await ports.managedCredentials().mcpTarget(scope, server.url);
    return managed === null
      ? null
      : { upstreamUrl: managed.upstreamUrl, upstreamToken: managed.upstreamToken, managed };
  }
  const grouped = await ports.legacyCredentials.listByVaults({
    tenantId: request.workspaceId,
    vaultIds: [...session.vaultIds],
  });
  return legacyVaultTarget(grouped, server.url);
}

interface LegacyAuthFields {
  type?: string;
  mcp_server_url?: string;
  mcpServerUrl?: string;
  bearer_token?: string;
  token?: string;
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  token_endpoint?: string;
  client_id?: string;
  client_secret?: string;
}

/** First active legacy credential bound to exactly `serverUrl`, in Vault order. */
function legacyVaultTarget(
  grouped: ReadonlyArray<{ vault_id: string; credentials: ReadonlyArray<{ id: string; auth?: unknown; archived_at?: unknown }> }>,
  serverUrl: string,
): McpProxyTarget | null {
  for (const group of grouped) {
    for (const credential of group.credentials) {
      const row = credential as { archived_at?: unknown; archivedAt?: unknown };
      if (row.archived_at || row.archivedAt) continue;
      const auth = credential.auth as LegacyAuthFields | undefined;
      if (auth === undefined || (auth.mcp_server_url ?? auth.mcpServerUrl) !== serverUrl) continue;
      const token = auth.bearer_token ?? auth.token ?? auth.access_token ?? auth.accessToken;
      if (!token) continue;
      // Only mcp_oauth carries refresh metadata; a static bearer is sent as is.
      if (auth.type !== "mcp_oauth" || !auth.refresh_token || !auth.token_endpoint) {
        return { upstreamUrl: serverUrl, upstreamToken: token };
      }
      return {
        upstreamUrl: serverUrl,
        upstreamToken: token,
        refresh: {
          refreshToken: auth.refresh_token,
          tokenEndpoint: auth.token_endpoint,
          ...(auth.client_id !== undefined && { clientId: auth.client_id }),
          ...(auth.client_secret !== undefined && { clientSecret: auth.client_secret }),
          credentialId: credential.id,
          vaultId: group.vault_id,
        },
      };
    }
  }
  return null;
}
