import type {
  CredentialInjectionLocation,
  CredentialNetworking,
} from "../domain/credential";

export type CredentialNetworkingInput =
  | { type: "unrestricted" }
  | { type: "limited"; allowedHosts: string[] };

export type CredentialNetworkingView = CredentialNetworking;

export interface CredentialInjectionLocationInput {
  body?: boolean;
  header?: boolean;
}

export type CredentialInjectionLocationView = CredentialInjectionLocation;

export type CredentialTokenEndpointAuthInput =
  | { type: "none" }
  | { type: "client_secret_basic"; clientSecret: string }
  | { type: "client_secret_post"; clientSecret: string };

export type CredentialTokenEndpointAuthView =
  | { type: "none" }
  | { type: "client_secret_basic" }
  | { type: "client_secret_post" };

export type CredentialTokenEndpointAuthUpdate =
  | { type: "client_secret_basic"; clientSecret?: string | null }
  | { type: "client_secret_post"; clientSecret?: string | null };

export interface CredentialOAuthRefreshInput {
  clientId: string;
  refreshToken: string;
  tokenEndpoint: string;
  tokenEndpointAuth: CredentialTokenEndpointAuthInput;
  resource?: string | null;
  scope?: string | null;
}

export interface CredentialOAuthRefreshView {
  clientId: string;
  tokenEndpoint: string;
  tokenEndpointAuth: CredentialTokenEndpointAuthView;
  resource?: string | null;
  scope?: string | null;
}

export interface CredentialOAuthRefreshUpdate {
  refreshToken?: string | null;
  scope?: string | null;
  tokenEndpointAuth?: CredentialTokenEndpointAuthUpdate;
}

export type CredentialAuthInput =
  | {
      type: "mcp_oauth";
      accessToken: string;
      mcpServerUrl: string;
      expiresAt?: string | null;
      refresh?: CredentialOAuthRefreshInput | null;
    }
  | {
      type: "static_bearer";
      token: string;
      mcpServerUrl: string;
    }
  | {
      type: "environment_variable";
      networking: CredentialNetworkingInput;
      secretName: string;
      secretValue: string;
      injectionLocation?: CredentialInjectionLocationInput;
    };

export type CredentialAuthView =
  | {
      type: "mcp_oauth";
      mcpServerUrl: string;
      expiresAt?: string | null;
      refresh?: CredentialOAuthRefreshView | null;
    }
  | { type: "static_bearer"; mcpServerUrl: string }
  | {
      type: "environment_variable";
      injectionLocation: CredentialInjectionLocationView;
      networking: CredentialNetworkingView;
      secretName: string;
    };

export type CredentialAuthUpdate =
  | {
      type: "mcp_oauth";
      accessToken?: string | null;
      expiresAt?: string | null;
      refresh?: CredentialOAuthRefreshUpdate | null;
    }
  | { type: "static_bearer"; token?: string | null }
  | {
      type: "environment_variable";
      injectionLocation?: CredentialInjectionLocationInput;
      networking?: CredentialNetworkingInput | null;
      secretValue?: string | null;
    };

export interface CredentialView {
  id: string;
  archivedAt: string | null;
  auth: CredentialAuthView;
  createdAt: string;
  metadata: Record<string, string>;
  updatedAt: string;
  vaultId: string;
  displayName?: string | null;
}

export interface CreateCredentialCommand {
  vaultId: string;
  auth: CredentialAuthInput;
  displayName?: string | null;
  metadata?: Record<string, string>;
}

export interface RetrieveCredentialQuery {
  vaultId: string;
  credentialId: string;
}

export interface UpdateCredentialCommand {
  vaultId: string;
  credentialId: string;
  auth?: CredentialAuthUpdate;
  displayName?: string | null;
  metadata?: Record<string, string | null> | null;
}

export interface ListCredentialsQuery {
  vaultId: string;
  pageSize?: number;
  cursor?: string;
  includeArchived?: boolean;
}

export interface CredentialsPage {
  credentials: CredentialView[];
  nextCursor: string | null;
}

export interface DeleteCredentialCommand {
  vaultId: string;
  credentialId: string;
}

export interface ArchiveCredentialCommand {
  vaultId: string;
  credentialId: string;
}

export interface ValidateCredentialCommand {
  vaultId: string;
  credentialId: string;
}

export interface CredentialResponseObservationView {
  body: string;
  bodyTruncated: boolean;
  contentType: string;
  statusCode: number;
}

export interface CredentialMcpProbeView {
  response: CredentialResponseObservationView | null;
  method: string;
}

export interface CredentialRefreshValidationView {
  response: CredentialResponseObservationView | null;
  status: "succeeded" | "failed" | "connect_error" | "no_refresh_token";
}

export interface CredentialValidationView {
  credentialId: string;
  hasRefreshToken: boolean;
  mcpProbe: CredentialMcpProbeView | null;
  refresh: CredentialRefreshValidationView | null;
  status: "valid" | "invalid" | "indeterminate";
  validatedAt: string;
  vaultId: string;
}

export type CreateCredentialResult =
  | { type: "created"; credential: CredentialView }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export type RetrieveCredentialResult =
  | { type: "found"; credential: CredentialView }
  | { type: "not_found" };

export type UpdateCredentialResult =
  | { type: "updated"; credential: CredentialView }
  | { type: "invalid_request"; message: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export type ListCredentialsResult =
  | { type: "page"; page: CredentialsPage }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export type DeleteCredentialResult =
  | { type: "deleted"; credentialId: string }
  | { type: "not_found" };

export type ArchiveCredentialResult =
  | { type: "archived"; credential: CredentialView }
  | { type: "not_found" };

export type ValidateCredentialResult =
  | { type: "validated"; validation: CredentialValidationView }
  | { type: "not_found" };

export interface CredentialsApplicationPort {
  createCredential(command: CreateCredentialCommand): Promise<CreateCredentialResult>;
  retrieveCredential(query: RetrieveCredentialQuery): Promise<RetrieveCredentialResult>;
  updateCredential(command: UpdateCredentialCommand): Promise<UpdateCredentialResult>;
  listCredentials(query: ListCredentialsQuery): Promise<ListCredentialsResult>;
  deleteCredential(command: DeleteCredentialCommand): Promise<DeleteCredentialResult>;
  archiveCredential(command: ArchiveCredentialCommand): Promise<ArchiveCredentialResult>;
  validateCredential(command: ValidateCredentialCommand): Promise<ValidateCredentialResult>;
}
