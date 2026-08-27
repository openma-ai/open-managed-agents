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
    };

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
