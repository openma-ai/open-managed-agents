export type CredentialNetworking =
  | { type: "unrestricted" }
  | { type: "limited"; allowedHosts: string[] };

export interface CredentialInjectionLocation {
  body: boolean;
  header: boolean;
}

export type CredentialTokenEndpointAuth =
  | { type: "none" }
  | { type: "client_secret_basic"; clientSecret: string | null }
  | { type: "client_secret_post"; clientSecret: string | null };

export interface CredentialOAuthRefresh {
  clientId: string;
  refreshToken: string | null;
  tokenEndpoint: string;
  tokenEndpointAuth: CredentialTokenEndpointAuth;
  resource?: string | null;
  scope?: string | null;
}

export type CredentialAuth =
  | {
      type: "mcp_oauth";
      accessToken: string | null;
      mcpServerUrl: string;
      expiresAt?: string | null;
      refresh?: CredentialOAuthRefresh | null;
    }
  | {
      type: "static_bearer";
      token: string | null;
      mcpServerUrl: string;
    }
  | {
      type: "environment_variable";
      networking: CredentialNetworking;
      secretName: string;
      secretValue: string | null;
      injectionLocation: CredentialInjectionLocation;
    }
  | CredentialCapCliAuth;

/**
 * OpenMA extension, not part of the Anthropic Managed Agents contract. A CLI
 * Auth Protocol credential: the egress proxy injects `token` into requests
 * to the endpoints of the CLI spec named by `cliId`. The sandbox only ever
 * sees the spec's placeholder environment values, never the token.
 */
export interface CredentialCapCliAuth {
  type: "cap_cli";
  cliId: string;
  token: string | null;
  refreshToken?: string | null;
  expiresAt?: string | null;
  extras?: Record<string, string>;
}

export interface Credential {
  id: string;
  archivedAt: string | null;
  auth: CredentialAuth;
  createdAt: string;
  metadata: Record<string, string>;
  updatedAt: string;
  vaultId: string;
  displayName?: string | null;
}
