import type { CredentialsApplicationPort } from "../ports/credentials";
import type {
  AuthorizeMcpOAuthCommand,
  AuthorizeMcpOAuthResult,
  CompleteMcpOAuthCommand,
  CompleteMcpOAuthResult,
  McpOAuthApplicationPort,
} from "../ports/mcp-oauth";
import type {
  McpOAuthPkce,
  McpOAuthPort,
  McpOAuthStateCipher,
} from "./mcp-oauth";

export interface McpOAuthApplicationServiceDependencies {
  workspaceId: string;
  credentials: CredentialsApplicationPort;
  oauth: McpOAuthPort;
  pkce: McpOAuthPkce;
  cipher: McpOAuthStateCipher;
  clock: { now(): Date };
  log: { warn(fields: Record<string, unknown>, message: string): void };
}

/** How long an authorization may take before its state is refused. */
const STATE_TTL_MS = 10 * 60 * 1000;

interface SealedAuthorization {
  v: 1;
  flow: "mcp_console";
  workspaceId: string;
  userId: string | null;
  vaultId: string;
  credentialId?: string;
  mcpServerUrl: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  resource: string;
  returnTo: string;
  expiresAtMs: number;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function parseSealed(value: unknown): SealedAuthorization | null {
  if (typeof value !== "object" || value === null) return null;
  const s = value as Record<string, unknown>;
  if (
    s.v !== 1
    || s.flow !== "mcp_console"
    || !isString(s.workspaceId)
    || (s.userId !== null && !isString(s.userId))
    || !isString(s.vaultId)
    || (s.credentialId !== undefined && !isString(s.credentialId))
    || !isString(s.mcpServerUrl)
    || !isString(s.codeVerifier)
    || !isString(s.clientId)
    || (s.clientSecret !== undefined && !isString(s.clientSecret))
    || !isString(s.tokenEndpoint)
    || !isString(s.resource)
    || !isString(s.returnTo)
    || typeof s.expiresAtMs !== "number"
  ) return null;
  return s as unknown as SealedAuthorization;
}

/** Short service label for the credential name: `mcp.linear.app` → `linear`. */
function serviceNameOf(mcpServerUrl: string): string {
  return new URL(mcpServerUrl).hostname.replace(/^mcp\./, "").replace(/\.(com|app|dev|io)$/, "");
}

/**
 * OpenMA extension: MCP OAuth 2.1 (Authorization Code + PKCE) ending in a
 * managed `mcp_oauth` credential carrying refresh metadata. No server-side
 * flow storage: the authorization travels sealed in the OAuth `state`. On
 * success older active `mcp_oauth` credentials for the same MCP server in the
 * Vault (and the one being re-authorized) are archived, so one stays active.
 */
export class McpOAuthApplicationService implements McpOAuthApplicationPort {
  constructor(private readonly dependencies: McpOAuthApplicationServiceDependencies) {}

  async authorize(command: AuthorizeMcpOAuthCommand): Promise<AuthorizeMcpOAuthResult> {
    let serverUrl: URL;
    try {
      serverUrl = new URL(command.mcpServerUrl);
    } catch {
      return { type: "invalid_request", message: "mcp_server_url must be an absolute URL" };
    }
    if (serverUrl.protocol !== "https:" && serverUrl.protocol !== "http:") {
      return { type: "invalid_request", message: "mcp_server_url must be an http(s) URL" };
    }
    const vault = await this.dependencies.credentials.listCredentials({
      vaultId: command.vaultId,
      pageSize: 1,
    });
    if (vault.type === "not_found") return { type: "not_found" };
    if (command.credentialId !== undefined) {
      const existing = await this.dependencies.credentials.retrieveCredential({
        vaultId: command.vaultId,
        credentialId: command.credentialId,
      });
      if (existing.type === "not_found") return { type: "not_found" };
      const auth = existing.credential.auth;
      if (auth.type !== "mcp_oauth" || auth.mcpServerUrl !== command.mcpServerUrl) {
        return {
          type: "invalid_request",
          message: "credential_id must name an mcp_oauth credential for the same mcp_server_url",
        };
      }
    }

    const discovered = await this.dependencies.oauth.discover(command.mcpServerUrl);
    if (discovered.type === "failed") {
      return { type: "discovery_failed", reason: discovered.reason };
    }
    const { metadata } = discovered;
    let client: { clientId: string; clientSecret?: string };
    if (command.clientId) {
      client = {
        clientId: command.clientId,
        ...(command.clientSecret && { clientSecret: command.clientSecret }),
      };
    } else {
      const resolved = await this.dependencies.oauth.client({
        metadata,
        ...(discovered.registrationEndpoint !== undefined && {
          registrationEndpoint: discovered.registrationEndpoint,
        }),
        callbackUri: command.callbackUri,
      });
      if (resolved.type === "unavailable") {
        return { type: "client_unavailable", message: resolved.message };
      }
      client = resolved.client;
    }

    const pkce = await this.dependencies.pkce.create();
    const state = await this.dependencies.cipher.encrypt(JSON.stringify({
      v: 1,
      flow: "mcp_console",
      workspaceId: this.dependencies.workspaceId,
      userId: command.userId,
      vaultId: command.vaultId,
      ...(command.credentialId !== undefined && { credentialId: command.credentialId }),
      mcpServerUrl: command.mcpServerUrl,
      codeVerifier: pkce.verifier,
      clientId: client.clientId,
      ...(client.clientSecret !== undefined && { clientSecret: client.clientSecret }),
      tokenEndpoint: metadata.tokenEndpoint,
      resource: metadata.resource,
      returnTo: command.returnTo,
      expiresAtMs: this.dependencies.clock.now().getTime() + STATE_TTL_MS,
    } satisfies SealedAuthorization));

    const url = new URL(metadata.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", command.callbackUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", metadata.resource);
    if (metadata.scopes.length > 0) url.searchParams.set("scope", metadata.scopes.join(" "));
    return { type: "redirect", authorizationUrl: url.toString() };
  }

  async complete(command: CompleteMcpOAuthCommand): Promise<CompleteMcpOAuthResult> {
    const flow = await this.open(command.state);
    if (
      flow === null
      || flow.workspaceId !== this.dependencies.workspaceId
      || flow.userId !== command.userId
      || this.dependencies.clock.now().getTime() >= flow.expiresAtMs
    ) return { type: "invalid_state" };

    const exchanged = await this.dependencies.oauth.exchangeCode({
      tokenEndpoint: flow.tokenEndpoint,
      code: command.code,
      codeVerifier: flow.codeVerifier,
      callbackUri: command.callbackUri,
      resource: flow.resource,
      client: {
        clientId: flow.clientId,
        ...(flow.clientSecret !== undefined && { clientSecret: flow.clientSecret }),
      },
    });
    if (exchanged.type === "failed") {
      return { type: "token_exchange_failed", reason: exchanged.reason };
    }
    const { tokens } = exchanged;
    const { credentials } = this.dependencies;
    const previous = await this.activeCredentialIds(flow.vaultId, flow.mcpServerUrl);
    if (flow.credentialId !== undefined && !previous.includes(flow.credentialId)) {
      previous.push(flow.credentialId);
    }
    const serviceName = serviceNameOf(flow.mcpServerUrl);
    const created = await credentials.createCredential({
      vaultId: flow.vaultId,
      displayName: `${serviceName} (OAuth)`,
      auth: {
        type: "mcp_oauth",
        mcpServerUrl: flow.mcpServerUrl,
        accessToken: tokens.accessToken,
        ...(tokens.expiresAt !== null && { expiresAt: tokens.expiresAt }),
        refresh: tokens.refreshToken === null
          ? null
          : {
              clientId: flow.clientId,
              refreshToken: tokens.refreshToken,
              tokenEndpoint: flow.tokenEndpoint,
              tokenEndpointAuth: flow.clientSecret === undefined
                ? { type: "none" }
                : { type: "client_secret_post", clientSecret: flow.clientSecret },
              resource: flow.resource,
            },
      },
    });
    if (created.type !== "created") return created;
    const unarchived: string[] = [];
    for (const credentialId of previous) {
      try {
        const archived = await credentials.archiveCredential({ vaultId: flow.vaultId, credentialId });
        if (archived.type !== "archived") unarchived.push(credentialId);
      } catch {
        unarchived.push(credentialId);
      }
    }
    if (unarchived.length > 0) {
      // Both the new and the replaced credentials stay active: selection
      // would be ambiguous, so the flow reports it instead of succeeding.
      this.dependencies.log.warn(
        {
          op: "mcp_oauth.archive_failed",
          workspace_id: this.dependencies.workspaceId,
          vault_id: flow.vaultId,
          credential_id: created.credential.id,
          unarchived_credential_ids: unarchived,
        },
        "MCP OAuth stored a credential but could not archive the ones it replaces",
      );
      return {
        type: "archive_failed",
        vaultId: flow.vaultId,
        credentialId: created.credential.id,
        unarchivedCredentialIds: unarchived,
      };
    }
    const probe = await this.dependencies.oauth.probe(flow.mcpServerUrl, tokens.accessToken);
    return {
      type: "connected",
      vaultId: flow.vaultId,
      credentialId: created.credential.id,
      serviceName,
      returnTo: flow.returnTo,
      probeOk: probe.ok,
      ...(probe.reason !== undefined && { probeReason: probe.reason }),
    };
  }

  private async activeCredentialIds(vaultId: string, mcpServerUrl: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.dependencies.credentials.listCredentials({
        vaultId,
        pageSize: 100,
        ...(cursor !== undefined && { cursor }),
      });
      if (page.type !== "page") return ids;
      for (const credential of page.page.credentials) {
        if (
          credential.archivedAt === null
          && credential.auth.type === "mcp_oauth"
          && credential.auth.mcpServerUrl === mcpServerUrl
        ) ids.push(credential.id);
      }
      if (page.page.nextCursor === null) return ids;
      cursor = page.page.nextCursor;
    }
  }

  private async open(state: string): Promise<SealedAuthorization | null> {
    try {
      return parseSealed(JSON.parse(await this.dependencies.cipher.decrypt(state)));
    } catch {
      return null;
    }
  }
}
