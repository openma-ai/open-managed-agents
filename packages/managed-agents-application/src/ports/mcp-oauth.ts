/**
 * OpenMA extension (not part of the Anthropic Managed Agents contract):
 * browser OAuth 2.1 Authorization Code + PKCE for an MCP server that ends in
 * a managed `mcp_oauth` Vault credential. The in-flight authorization is
 * carried by an opaque, sealed `state` bound to the workspace and Vault.
 */
export interface AuthorizeMcpOAuthCommand {
  vaultId: string;
  mcpServerUrl: string;
  /** Re-authorize this credential instead of creating a new one. */
  credentialId?: string;
  /** Where the browser returns after the flow. */
  returnTo: string;
  /** Pinned OAuth client; skips registration and operator presets. */
  clientId?: string;
  clientSecret?: string;
  /** Absolute redirect URI registered with the authorization server. */
  callbackUri: string;
}

export type AuthorizeMcpOAuthResult =
  | { type: "redirect"; authorizationUrl: string }
  | { type: "not_found" }
  | { type: "invalid_request"; message: string }
  | { type: "discovery_failed"; message: string }
  /** No usable OAuth client: no registration endpoint and no preset. */
  | { type: "client_unavailable"; message: string };

export interface CompleteMcpOAuthCommand {
  state: string;
  code: string;
  callbackUri: string;
}

export type CompleteMcpOAuthResult =
  | {
      type: "connected";
      vaultId: string;
      credentialId: string;
      serviceName: string;
      returnTo: string;
      probeOk: boolean;
      probeMessage?: string;
    }
  | { type: "invalid_state" }
  | { type: "token_exchange_failed"; message: string }
  | { type: "not_found" }
  | { type: "invalid_request"; message: string };

export interface McpOAuthApplicationPort {
  authorize(command: AuthorizeMcpOAuthCommand): Promise<AuthorizeMcpOAuthResult>;
  complete(command: CompleteMcpOAuthCommand): Promise<CompleteMcpOAuthResult>;
}
