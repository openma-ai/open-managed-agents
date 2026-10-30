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
  /** Authenticated user starting the flow; null for a workspace API key. */
  userId: string | null;
}

export type AuthorizeMcpOAuthResult =
  | { type: "redirect"; authorizationUrl: string }
  | { type: "not_found" }
  | { type: "invalid_request"; message: string }
  /** Discovery failed; `reason` is a fixed code, never upstream content. */
  | { type: "discovery_failed"; reason: McpOAuthFailureReason }
  /** No usable OAuth client: no registration endpoint and no preset. */
  | { type: "client_unavailable"; message: string };

/** Fixed failure codes. Upstream bodies and URLs are never surfaced. */
export type McpOAuthFailureReason =
  | "metadata_unavailable"
  | "metadata_invalid"
  | "upstream_unreachable"
  | "upstream_rejected"
  | "upstream_invalid_response";

export interface CompleteMcpOAuthCommand {
  state: string;
  code: string;
  callbackUri: string;
  /** Must be the user that started the flow. */
  userId: string | null;
}

export type CompleteMcpOAuthResult =
  | {
      type: "connected";
      vaultId: string;
      credentialId: string;
      serviceName: string;
      returnTo: string;
      probeOk: boolean;
      /** e.g. `http_401`; never upstream content. */
      probeReason?: string;
    }
  | { type: "invalid_state" }
  | { type: "token_exchange_failed"; reason: McpOAuthFailureReason }
  | { type: "not_found" }
  | { type: "invalid_request"; message: string }
  /** The credential was stored, but a replaced one could not be archived. */
  | {
      type: "archive_failed";
      vaultId: string;
      credentialId: string;
      unarchivedCredentialIds: string[];
    };

export interface McpOAuthApplicationPort {
  authorize(command: AuthorizeMcpOAuthCommand): Promise<AuthorizeMcpOAuthResult>;
  complete(command: CompleteMcpOAuthCommand): Promise<CompleteMcpOAuthResult>;
}
