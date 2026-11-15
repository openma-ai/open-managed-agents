import type { AccessLossRuntime } from "@open-managed-agents/mcp-access-loss";
import type { ManagedCredentialResolver } from "@open-managed-agents/managed-credential-resolver";
import type { CredentialService } from "@open-managed-agents/credentials-store";
import type { ProxySessionSourcesPort } from "./proxy-session";

/** Managed (v1) Vault credentials: the shared resolver on both platforms. */
export type ManagedMcpCredentialsPort = Pick<ManagedCredentialResolver, "mcpTarget" | "forward">;

/** Legacy `/v1/oma` Vault credentials, read for matching and rewritten in
 * place (compare-and-swap) when an OAuth token is refreshed. */
export type LegacyMcpCredentialsPort = Pick<
  CredentialService,
  "listByVaults" | "get" | "getRawForRefresh" | "refreshAuth" | "refreshAuthCAS"
>;

export interface McpProxyLogPort {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** What one workspace's MCP proxy reads and calls. Cloudflare and Node build
 * it from their stores; the proxy itself is the same code on both. */
export interface McpProxyPorts {
  sessions: ProxySessionSourcesPort;
  legacyCredentials: LegacyMcpCredentialsPort;
  /** Built only for a managed Session with Vaults attached. */
  managedCredentials(): ManagedMcpCredentialsPort;
  /** Closes an integration scope when the upstream reports lost access. */
  accessLoss?: AccessLossRuntime;
  log: McpProxyLogPort;
  /** Upstream and token-endpoint transport; the global fetch when absent. */
  fetch?: typeof fetch;
}
