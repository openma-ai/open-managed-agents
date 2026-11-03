import type {
  Credential,
  CredentialAuth,
  CredentialOAuthRefresh,
  CredentialTokenEndpointAuth,
} from "../domain/credential";
import type {
  ArchiveCredentialCommand,
  ArchiveCredentialResult,
  CreateCredentialCommand,
  CreateCredentialResult,
  CredentialAuthInput,
  CredentialAuthUpdate,
  CredentialAuthView,
  CredentialOAuthRefreshUpdate,
  CredentialTokenEndpointAuthUpdate,
  CredentialView,
  CredentialsApplicationPort,
  DeleteCredentialCommand,
  DeleteCredentialResult,
  ListCredentialsQuery,
  ListCredentialsResult,
  RetrieveCredentialQuery,
  RetrieveCredentialResult,
  UpdateCredentialCommand,
  UpdateCredentialResult,
  ValidateCredentialCommand,
  ValidateCredentialResult,
} from "../ports/credentials";
import type { CredentialStore } from "@open-managed-agents/credential-store";
import type {
  CredentialValidationProbePort,
  CredentialValidationRotation,
} from "./validation";
import type { CredentialCliCatalogPort } from "./cli-catalog";
import type { CredentialVaultSourcePort } from "./vault-source";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeCredentialCursor(credential: Credential): string {
  return `credentials.${encodeCursorPart(credential.createdAt)}.${encodeCursorPart(credential.id)}`;
}

function decodeCredentialCursor(
  value: string,
): { createdAt: string; credentialId: string } | null {
  const [scope, createdAt, credentialId, extra] = value.split(".");
  if (
    scope !== "credentials" ||
    createdAt === undefined ||
    credentialId === undefined ||
    extra !== undefined
  ) return null;
  const decodedCreatedAt = decodeCursorPart(createdAt);
  const decodedCredentialId = decodeCursorPart(credentialId);
  if (
    decodedCreatedAt === null ||
    decodedCredentialId === null ||
    decodedCredentialId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return { createdAt: decodedCreatedAt, credentialId: decodedCredentialId };
}

function resolveCreateAuth(input: CredentialAuthInput): CredentialAuth {
  if (input.type === "static_bearer") return { ...input };
  if (input.type === "cap_cli") {
    return {
      type: input.type,
      cliId: input.cliId,
      token: input.token,
      ...(input.refreshToken !== undefined && { refreshToken: input.refreshToken }),
      ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
      ...(input.extras !== undefined && { extras: { ...input.extras } }),
    };
  }
  if (input.type === "environment_variable") {
    return {
      type: input.type,
      networking:
        input.networking.type === "unrestricted"
          ? { type: "unrestricted" }
          : { type: "limited", allowedHosts: [...input.networking.allowedHosts] },
      secretName: input.secretName,
      secretValue: input.secretValue,
      injectionLocation: {
        body: input.injectionLocation?.body ?? false,
        header: input.injectionLocation?.header ?? false,
      },
    };
  }
  return {
    type: input.type,
    accessToken: input.accessToken,
    mcpServerUrl: input.mcpServerUrl,
    ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
    ...(input.refresh !== undefined && {
      refresh:
        input.refresh === null
          ? null
          : {
              ...input.refresh,
              tokenEndpointAuth: { ...input.refresh.tokenEndpointAuth },
            },
    }),
  };
}

function toAuthView(auth: CredentialAuth): CredentialAuthView {
  if (auth.type === "static_bearer") {
    return { type: auth.type, mcpServerUrl: auth.mcpServerUrl };
  }
  if (auth.type === "cap_cli") {
    return {
      type: auth.type,
      cliId: auth.cliId,
      ...(auth.expiresAt !== undefined && { expiresAt: auth.expiresAt }),
    };
  }
  if (auth.type === "environment_variable") {
    return {
      type: auth.type,
      injectionLocation: { ...auth.injectionLocation },
      networking:
        auth.networking.type === "unrestricted"
          ? { type: "unrestricted" }
          : { type: "limited", allowedHosts: [...auth.networking.allowedHosts] },
      secretName: auth.secretName,
    };
  }
  return {
    type: auth.type,
    mcpServerUrl: auth.mcpServerUrl,
    ...(auth.expiresAt !== undefined && { expiresAt: auth.expiresAt }),
    ...(auth.refresh !== undefined && {
      refresh:
        auth.refresh === null
          ? null
          : {
              clientId: auth.refresh.clientId,
              tokenEndpoint: auth.refresh.tokenEndpoint,
              tokenEndpointAuth: { type: auth.refresh.tokenEndpointAuth.type },
              ...(auth.refresh.resource !== undefined && {
                resource: auth.refresh.resource,
              }),
              ...(auth.refresh.scope !== undefined && { scope: auth.refresh.scope }),
            },
    }),
  };
}

function toView(credential: Credential): CredentialView {
  return {
    id: credential.id,
    archivedAt: credential.archivedAt,
    auth: toAuthView(credential.auth),
    createdAt: credential.createdAt,
    metadata: { ...credential.metadata },
    updatedAt: credential.updatedAt,
    vaultId: credential.vaultId,
    ...(credential.displayName !== undefined && {
      displayName: credential.displayName,
    }),
  };
}

function patchMetadata(
  current: Record<string, string>,
  patch: Record<string, string | null> | null,
): Record<string, string> {
  if (patch === null) return {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function patchTokenEndpointAuth(
  current: CredentialTokenEndpointAuth,
  update: CredentialTokenEndpointAuthUpdate,
): CredentialTokenEndpointAuth {
  return {
    type: update.type,
    clientSecret:
      update.clientSecret !== undefined
        ? update.clientSecret
        : current.type === update.type
          ? current.clientSecret
          : null,
  };
}

function patchOAuthRefresh(
  current: CredentialOAuthRefresh | null | undefined,
  update: CredentialOAuthRefreshUpdate | null,
): CredentialOAuthRefresh | null {
  if (update === null) return null;
  if (current === null || current === undefined) return null;
  return {
    ...current,
    ...(update.refreshToken !== undefined && { refreshToken: update.refreshToken }),
    ...(update.scope !== undefined && { scope: update.scope }),
    ...(update.tokenEndpointAuth !== undefined && {
      tokenEndpointAuth: patchTokenEndpointAuth(
        current.tokenEndpointAuth,
        update.tokenEndpointAuth,
      ),
    }),
  };
}

function patchAuth(
  current: CredentialAuth,
  update: CredentialAuthUpdate,
): CredentialAuth | null {
  if (current.type !== update.type) return null;
  if (current.type === "static_bearer" && update.type === "static_bearer") {
    return {
      ...current,
      ...(update.token !== undefined && { token: update.token }),
    };
  }
  if (
    current.type === "environment_variable" &&
    update.type === "environment_variable"
  ) {
    return {
      ...current,
      ...(update.secretValue !== undefined && { secretValue: update.secretValue }),
      ...(update.networking !== undefined && {
        networking:
          update.networking === null
            ? { type: "unrestricted" as const }
            : update.networking.type === "unrestricted"
              ? { type: "unrestricted" as const }
              : {
                  type: "limited" as const,
                  allowedHosts: [...update.networking.allowedHosts],
                },
      }),
      ...(update.injectionLocation !== undefined && {
        injectionLocation: {
          body: update.injectionLocation.body ?? current.injectionLocation.body,
          header:
            update.injectionLocation.header ?? current.injectionLocation.header,
        },
      }),
    };
  }
  if (current.type === "cap_cli" && update.type === "cap_cli") {
    const { extras, ...rest } = current;
    const nextExtras =
      update.extras === undefined
        ? extras
        : update.extras === null
          ? undefined
          : { ...update.extras };
    return {
      ...rest,
      ...(update.token !== undefined && { token: update.token }),
      ...(update.refreshToken !== undefined && { refreshToken: update.refreshToken }),
      ...(update.expiresAt !== undefined && { expiresAt: update.expiresAt }),
      ...(nextExtras !== undefined && { extras: nextExtras }),
    };
  }
  if (current.type === "mcp_oauth" && update.type === "mcp_oauth") {
    return {
      ...current,
      ...(update.accessToken !== undefined && { accessToken: update.accessToken }),
      ...(update.expiresAt !== undefined && { expiresAt: update.expiresAt }),
      ...(update.refresh !== undefined && {
        refresh: patchOAuthRefresh(current.refresh, update.refresh),
      }),
    };
  }
  return null;
}

export interface CredentialsApplicationServiceDependencies {
  workspaceId: string;
  store: CredentialStore;
  vaults: CredentialVaultSourcePort;
  validation: CredentialValidationProbePort;
  cliCatalog: CredentialCliCatalogPort;
  clock: { now(): Date };
  ids: { nextCredentialId(): string };
}

export class CredentialsApplicationService implements CredentialsApplicationPort {
  constructor(
    private readonly dependencies: CredentialsApplicationServiceDependencies,
  ) {}

  async createCredential(
    command: CreateCredentialCommand,
  ): Promise<CreateCredentialResult> {
    const vault = await this.dependencies.vaults.find({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
    });
    if (vault === null || vault.archivedAt !== null) return { type: "not_found" };
    if (
      command.auth.type === "cap_cli" &&
      !this.dependencies.cliCatalog.has(command.auth.cliId)
    ) {
      return {
        type: "invalid_request",
        message: `Unknown cap_cli cli_id "${command.auth.cliId}"`,
      };
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    const credential: Credential = {
      id: this.dependencies.ids.nextCredentialId(),
      archivedAt: null,
      auth: resolveCreateAuth(command.auth),
      createdAt: timestamp,
      metadata: command.metadata ?? {},
      updatedAt: timestamp,
      vaultId: command.vaultId,
      ...(command.displayName !== undefined && {
        displayName: command.displayName,
      }),
    };
    const record = await this.dependencies.store.insert({
      workspaceId: this.dependencies.workspaceId,
      credential,
    });
    return { type: "created", credential: toView(record.credential) };
  }

  async retrieveCredential(
    query: RetrieveCredentialQuery,
  ): Promise<RetrieveCredentialResult> {
    const record = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      vaultId: query.vaultId,
      credentialId: query.credentialId,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", credential: toView(record.credential) };
  }

  async updateCredential(
    command: UpdateCredentialCommand,
  ): Promise<UpdateCredentialResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
      credentialId: command.credentialId,
    });
    if (current === null) return { type: "not_found" };
    const auth =
      command.auth === undefined
        ? current.credential.auth
        : patchAuth(current.credential.auth, command.auth);
    if (auth === null) {
      return {
        type: "invalid_request",
        message: "Credential auth type is immutable",
      };
    }
    const next: Credential = {
      ...current.credential,
      auth,
      ...(command.metadata !== undefined && {
        metadata: patchMetadata(current.credential.metadata, command.metadata),
      }),
      updatedAt: this.dependencies.clock.now().toISOString(),
    };
    if (command.displayName !== undefined) {
      next.displayName = command.displayName;
    }
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
      credentialId: command.credentialId,
      expectedRevision: current.revision,
      next,
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Credential changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "updated", credential: toView(replaced.record.credential) };
  }

  async listCredentials(
    query: ListCredentialsQuery,
  ): Promise<ListCredentialsResult> {
    const vault = await this.dependencies.vaults.find({
      workspaceId: this.dependencies.workspaceId,
      vaultId: query.vaultId,
    });
    if (vault === null) return { type: "not_found" };
    const position =
      query.cursor === undefined
        ? undefined
        : decodeCredentialCursor(query.cursor);
    if (position === null) {
      return { type: "invalid_request", message: "Invalid credential page cursor" };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      vaultId: query.vaultId,
      limit: pageSize + 1,
      includeArchived: query.includeArchived ?? false,
      ...(position !== undefined && { position }),
    });
    const hasMore = records.length > pageSize;
    const credentials = (hasMore ? records.slice(0, pageSize) : records).map(
      (record) => toView(record.credential),
    );
    const lastRecord = (hasMore ? records.slice(0, pageSize) : records).at(-1);
    return {
      type: "page",
      page: {
        credentials,
        nextCursor:
          hasMore && lastRecord !== undefined
            ? encodeCredentialCursor(lastRecord.credential)
            : null,
      },
    };
  }

  async deleteCredential(
    command: DeleteCredentialCommand,
  ): Promise<DeleteCredentialResult> {
    const result = await this.dependencies.store.delete({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
      credentialId: command.credentialId,
    });
    return result.type === "not_found"
      ? result
      : { type: "deleted", credentialId: command.credentialId };
  }

  async archiveCredential(
    command: ArchiveCredentialCommand,
  ): Promise<ArchiveCredentialResult> {
    const result = await this.dependencies.store.archive({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
      credentialId: command.credentialId,
      archivedAt: this.dependencies.clock.now().toISOString(),
    });
    return result.type === "not_found"
      ? result
      : { type: "archived", credential: toView(result.record.credential) };
  }

  async validateCredential(
    command: ValidateCredentialCommand,
  ): Promise<ValidateCredentialResult> {
    const record = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      vaultId: command.vaultId,
      credentialId: command.credentialId,
    });
    if (record === null) return { type: "not_found" };
    if (record.credential.auth.type === "cap_cli") {
      return {
        type: "invalid_request",
        message: "cap_cli credentials are not MCP credentials and cannot be validated",
      };
    }
    const validation = await this.dependencies.validation.validate({
      workspaceId: this.dependencies.workspaceId,
      credential: record.credential,
    });
    const rotation = validation.rotation ?? null;
    if (rotation !== null && rotation.accessToken.length > 0) {
      try {
        await this.persistRotation(record, rotation);
      } catch (error) {
        // Driver errors can embed the sealed document. Keep only the error
        // name, never error.message, out of logs and the HTTP error page.
        const name = error instanceof Error ? error.name : "Error";
        console.warn(`credential rotation could not be persisted (${name})`);
      }
    }
    return {
      type: "validated",
      validation: {
        credentialId: record.credential.id,
        hasRefreshToken: validation.hasRefreshToken,
        mcpProbe:
          validation.mcpProbe === null
            ? null
            : {
                response:
                  validation.mcpProbe.response === null
                    ? null
                    : { ...validation.mcpProbe.response },
                method: validation.mcpProbe.method,
              },
        refresh:
          validation.refresh === null
            ? null
            : {
                response:
                  validation.refresh.response === null
                    ? null
                    : { ...validation.refresh.response },
                status: validation.refresh.status,
              },
        status: validation.status,
        validatedAt: this.dependencies.clock.now().toISOString(),
        vaultId: record.credential.vaultId,
      },
    };
  }

  private async persistRotation(
    record: { credential: Credential; revision: number },
    rotation: CredentialValidationRotation,
  ): Promise<void> {
    let current = record;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const next = applyCredentialRotation(
        current.credential,
        rotation,
        this.dependencies.clock.now().toISOString(),
      );
      if (next === null) return;
      const replaced = await this.dependencies.store.replace({
        workspaceId: this.dependencies.workspaceId,
        vaultId: current.credential.vaultId,
        credentialId: current.credential.id,
        expectedRevision: current.revision,
        next,
      });
      if (replaced.type === "replaced" || replaced.type === "not_found") return;
      const latest = await this.dependencies.store.find({
        workspaceId: this.dependencies.workspaceId,
        vaultId: current.credential.vaultId,
        credentialId: current.credential.id,
      });
      if (latest === null) return;
      current = latest;
    }
  }
}

function applyCredentialRotation(
  credential: Credential,
  rotation: CredentialValidationRotation,
  updatedAt: string,
): Credential | null {
  if (credential.auth.type !== "mcp_oauth") return null;
  const refresh = credential.auth.refresh;
  return {
    ...credential,
    auth: {
      ...credential.auth,
      accessToken: rotation.accessToken,
      ...(rotation.expiresAt !== null ? { expiresAt: rotation.expiresAt } : {}),
      ...(refresh != null && rotation.refreshToken !== null
        ? { refresh: { ...refresh, refreshToken: rotation.refreshToken } }
        : {}),
    },
    updatedAt,
  };
}
