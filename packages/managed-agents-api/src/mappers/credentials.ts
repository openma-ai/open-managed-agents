import type {
  CredentialCreateBody,
  CredentialListQuery,
  CredentialUpdateBody,
} from "../contracts/credentials";
import type {
  ArchiveCredentialCommand,
  CreateCredentialCommand,
  CredentialAuthInput,
  CredentialAuthUpdate,
  CredentialAuthView,
  CredentialNetworkingInput,
  CredentialTokenEndpointAuthInput,
  CredentialTokenEndpointAuthUpdate,
  CredentialResponseObservationView,
  CredentialValidationView,
  CredentialView,
  DeleteCredentialCommand,
  ListCredentialsQuery,
  RetrieveCredentialQuery,
  UpdateCredentialCommand,
  ValidateCredentialCommand,
} from "../ports/credentials";

type WireCreateAuth = CredentialCreateBody["auth"];
type WireUpdateAuth = NonNullable<CredentialUpdateBody["auth"]>;

function toNetworkingInput(
  networking: Extract<WireCreateAuth, { type: "environment_variable" }>["networking"],
): CredentialNetworkingInput {
  return networking.type === "unrestricted"
    ? { type: networking.type }
    : { type: networking.type, allowedHosts: networking.allowed_hosts };
}

function toTokenEndpointAuthInput(
  auth: Extract<WireCreateAuth, { type: "mcp_oauth" }>["refresh"] extends infer Refresh
    ? NonNullable<Refresh> extends { token_endpoint_auth: infer Auth }
      ? Auth
      : never
    : never,
): CredentialTokenEndpointAuthInput {
  if (auth.type === "none") return { type: auth.type };
  return { type: auth.type, clientSecret: auth.client_secret };
}

function toTokenEndpointAuthUpdate(
  auth: NonNullable<
    NonNullable<
      Extract<WireUpdateAuth, { type: "mcp_oauth" }>["refresh"]
    >["token_endpoint_auth"]
  >,
): CredentialTokenEndpointAuthUpdate {
  return {
    type: auth.type,
    ...(auth.client_secret !== undefined && {
      clientSecret: auth.client_secret,
    }),
  };
}

function toCredentialAuthInput(auth: WireCreateAuth): CredentialAuthInput {
  if (auth.type === "static_bearer") {
    return {
      type: auth.type,
      token: auth.token,
      mcpServerUrl: auth.mcp_server_url,
    };
  }
  if (auth.type === "environment_variable") {
    return {
      type: auth.type,
      networking: toNetworkingInput(auth.networking),
      secretName: auth.secret_name,
      secretValue: auth.secret_value,
      ...(auth.injection_location !== undefined && {
        injectionLocation: {
          ...(auth.injection_location.body !== undefined && {
            body: auth.injection_location.body,
          }),
          ...(auth.injection_location.header !== undefined && {
            header: auth.injection_location.header,
          }),
        },
      }),
    };
  }
  return {
    type: auth.type,
    accessToken: auth.access_token,
    mcpServerUrl: auth.mcp_server_url,
    ...(auth.expires_at !== undefined && { expiresAt: auth.expires_at }),
    ...(auth.refresh !== undefined && {
      refresh:
        auth.refresh === null
          ? null
          : {
              clientId: auth.refresh.client_id,
              refreshToken: auth.refresh.refresh_token,
              tokenEndpoint: auth.refresh.token_endpoint,
              tokenEndpointAuth: toTokenEndpointAuthInput(
                auth.refresh.token_endpoint_auth,
              ),
              ...(auth.refresh.resource !== undefined && {
                resource: auth.refresh.resource,
              }),
              ...(auth.refresh.scope !== undefined && {
                scope: auth.refresh.scope,
              }),
            },
    }),
  };
}

function toCredentialAuthUpdate(auth: WireUpdateAuth): CredentialAuthUpdate {
  if (auth.type === "static_bearer") {
    return {
      type: auth.type,
      ...(auth.token !== undefined && { token: auth.token }),
    };
  }
  if (auth.type === "environment_variable") {
    return {
      type: auth.type,
      ...(auth.injection_location !== undefined && {
        injectionLocation: {
          ...(auth.injection_location.body !== undefined && {
            body: auth.injection_location.body,
          }),
          ...(auth.injection_location.header !== undefined && {
            header: auth.injection_location.header,
          }),
        },
      }),
      ...(auth.networking !== undefined && {
        networking:
          auth.networking === null
            ? null
            : toNetworkingInput(auth.networking),
      }),
      ...(auth.secret_value !== undefined && { secretValue: auth.secret_value }),
    };
  }
  return {
    type: auth.type,
    ...(auth.access_token !== undefined && { accessToken: auth.access_token }),
    ...(auth.expires_at !== undefined && { expiresAt: auth.expires_at }),
    ...(auth.refresh !== undefined && {
      refresh:
        auth.refresh === null
          ? null
          : {
              ...(auth.refresh.refresh_token !== undefined && {
                refreshToken: auth.refresh.refresh_token,
              }),
              ...(auth.refresh.scope !== undefined && {
                scope: auth.refresh.scope,
              }),
              ...(auth.refresh.token_endpoint_auth !== undefined && {
                tokenEndpointAuth: toTokenEndpointAuthUpdate(
                  auth.refresh.token_endpoint_auth,
                ),
              }),
            },
    }),
  };
}

export function toCreateCredentialCommand(
  vaultId: string,
  body: CredentialCreateBody,
): CreateCredentialCommand {
  return {
    vaultId,
    auth: toCredentialAuthInput(body.auth),
    ...(body.display_name !== undefined && {
      displayName: body.display_name,
    }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
  };
}

export function toRetrieveCredentialQuery(
  vaultId: string,
  credentialId: string,
): RetrieveCredentialQuery {
  return { vaultId, credentialId };
}

export function toUpdateCredentialCommand(
  vaultId: string,
  credentialId: string,
  body: CredentialUpdateBody,
): UpdateCredentialCommand {
  return {
    vaultId,
    credentialId,
    ...(body.auth !== undefined && {
      auth: toCredentialAuthUpdate(body.auth),
    }),
    ...(body.display_name !== undefined && {
      displayName: body.display_name,
    }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
  };
}

export function toListCredentialsQuery(
  vaultId: string,
  query: CredentialListQuery,
): ListCredentialsQuery {
  return {
    vaultId,
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query.include_archived !== undefined && {
      includeArchived: query.include_archived,
    }),
  };
}

export function toDeleteCredentialCommand(
  vaultId: string,
  credentialId: string,
): DeleteCredentialCommand {
  return { vaultId, credentialId };
}

export function toArchiveCredentialCommand(
  vaultId: string,
  credentialId: string,
): ArchiveCredentialCommand {
  return { vaultId, credentialId };
}

export function toValidateCredentialCommand(
  vaultId: string,
  credentialId: string,
): ValidateCredentialCommand {
  return { vaultId, credentialId };
}

function fromCredentialAuth(auth: CredentialAuthView): object {
  if (auth.type === "static_bearer") {
    return { type: auth.type, mcp_server_url: auth.mcpServerUrl };
  }
  if (auth.type === "environment_variable") {
    return {
      type: auth.type,
      injection_location: auth.injectionLocation,
      networking:
        auth.networking.type === "unrestricted"
          ? { type: auth.networking.type }
          : {
              type: auth.networking.type,
              allowed_hosts: auth.networking.allowedHosts,
            },
      secret_name: auth.secretName,
    };
  }
  return {
    type: auth.type,
    mcp_server_url: auth.mcpServerUrl,
    ...(auth.expiresAt !== undefined && { expires_at: auth.expiresAt }),
    ...(auth.refresh !== undefined && {
      refresh:
        auth.refresh === null
          ? null
          : {
              client_id: auth.refresh.clientId,
              token_endpoint: auth.refresh.tokenEndpoint,
              token_endpoint_auth: {
                type: auth.refresh.tokenEndpointAuth.type,
              },
              ...(auth.refresh.resource !== undefined && {
                resource: auth.refresh.resource,
              }),
              ...(auth.refresh.scope !== undefined && {
                scope: auth.refresh.scope,
              }),
            },
    }),
  };
}

export function toCredentialResponse(credential: CredentialView): object {
  return {
    id: credential.id,
    archived_at: credential.archivedAt,
    auth: fromCredentialAuth(credential.auth),
    created_at: credential.createdAt,
    metadata: credential.metadata,
    type: "vault_credential",
    updated_at: credential.updatedAt,
    vault_id: credential.vaultId,
    ...(credential.displayName !== undefined && {
      display_name: credential.displayName,
    }),
  };
}

function fromResponseObservation(
  response: CredentialResponseObservationView,
): object {
  return {
    body: response.body,
    body_truncated: response.bodyTruncated,
    content_type: response.contentType,
    status_code: response.statusCode,
  };
}

export function toCredentialValidationResponse(
  validation: CredentialValidationView,
): object {
  return {
    credential_id: validation.credentialId,
    has_refresh_token: validation.hasRefreshToken,
    mcp_probe:
      validation.mcpProbe === null
        ? null
        : {
            http_response:
              validation.mcpProbe.response === null
                ? null
                : fromResponseObservation(validation.mcpProbe.response),
            method: validation.mcpProbe.method,
          },
    refresh:
      validation.refresh === null
        ? null
        : {
            http_response:
              validation.refresh.response === null
                ? null
                : fromResponseObservation(validation.refresh.response),
            status: validation.refresh.status,
          },
    status:
      validation.status === "indeterminate" ? "unknown" : validation.status,
    type: "vault_credential_validation",
    validated_at: validation.validatedAt,
    vault_id: validation.vaultId,
  };
}
