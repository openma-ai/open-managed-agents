/**
 * Credential selection and refresh for v1 managed Sessions.
 *
 * Reads the managed domain shape (`managed_credentials`, camelCase) directly.
 * The legacy `/v1/oma` Session path in mcp-proxy.ts keeps its own snake_case
 * logic; nothing here converts between the two.
 */
import type { CapSpec, SpecRegistry } from "@open-managed-agents/cap";
import type {
  Credential,
  CredentialAuth,
} from "@open-managed-agents/managed-agents-application";

export interface ManagedProxyCredentialRecord {
  revision: number;
  credential: Credential;
}

export type ManagedCredentialReplaceResult =
  | { type: "replaced"; record: ManagedProxyCredentialRecord }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

/**
 * Credential half of the managed MCP boundary, backed by the official v1
 * Vault store. `find` + `replace` are what refresh needs to write rotated
 * tokens back with a revision check.
 */
export interface McpProxyCredentialSource {
  listByVaults(input: {
    workspaceId: string;
    vaultIds: string[];
  }): Promise<ManagedProxyCredentialRecord[]>;
  find(input: {
    workspaceId: string;
    vaultId: string;
    credentialId: string;
  }): Promise<ManagedProxyCredentialRecord | null>;
  replace(input: {
    workspaceId: string;
    vaultId: string;
    credentialId: string;
    expectedRevision: number;
    next: Credential;
  }): Promise<ManagedCredentialReplaceResult>;
}

/** Refresh metadata for a managed credential; persisted through `source`. */
export interface ManagedCredentialRefresh {
  /** Present when the credential was resolved; refresh itself always uses
   *  the refresh token stored at that moment, read back from `source`. */
  refreshToken: string;
  tokenEndpoint: string;
  clientId?: string;
  clientSecret?: string;
  credentialId: string;
  vaultId: string;
  credentialSource: McpProxyCredentialSource;
}

export interface ManagedProxyTarget {
  upstreamUrl: string;
  upstreamToken: string;
  refresh?: ManagedCredentialRefresh;
}

function timestamp(credential: Credential): number {
  return Date.parse(credential.updatedAt) || Date.parse(credential.createdAt) || 0;
}

/** The token a credential injects as a Bearer, or null when it has none. */
function bearerOf(auth: CredentialAuth): string | null {
  switch (auth.type) {
    case "mcp_oauth":
      return auth.accessToken || null;
    case "static_bearer":
      return auth.token || null;
    case "cap_cli":
      return auth.token || null;
    case "environment_variable":
      // Injected as sandbox environment, never as a proxy Bearer.
      return null;
  }
}

function mcpServerUrlOf(auth: CredentialAuth): string | null {
  switch (auth.type) {
    case "mcp_oauth":
    case "static_bearer":
      return auth.mcpServerUrl;
    case "cap_cli":
    case "environment_variable":
      return null;
  }
}

function mcpOAuthRefresh(
  record: ManagedProxyCredentialRecord,
  source: McpProxyCredentialSource,
): ManagedCredentialRefresh | undefined {
  const { credential } = record;
  const auth = credential.auth;
  if (auth.type !== "mcp_oauth" || auth.refresh == null) return undefined;
  const refreshToken = auth.refresh.refreshToken;
  if (!refreshToken || !auth.refresh.tokenEndpoint) return undefined;
  const endpointAuth = auth.refresh.tokenEndpointAuth;
  const clientSecret = endpointAuth.type === "none" ? null : endpointAuth.clientSecret;
  return {
    refreshToken,
    tokenEndpoint: auth.refresh.tokenEndpoint,
    clientId: auth.refresh.clientId,
    ...(clientSecret ? { clientSecret } : {}),
    credentialId: credential.id,
    vaultId: credential.vaultId,
    credentialSource: source,
  };
}

function capCliRefresh(
  record: ManagedProxyCredentialRecord,
  spec: CapSpec,
  source: McpProxyCredentialSource,
): ManagedCredentialRefresh | undefined {
  const auth = record.credential.auth;
  if (auth.type !== "cap_cli" || !auth.refreshToken) return undefined;
  const deviceFlow = spec.oauth?.device_flow;
  if (!deviceFlow?.token_url) return undefined;
  return {
    refreshToken: auth.refreshToken,
    tokenEndpoint: deviceFlow.token_url,
    clientId: deviceFlow.client_id,
    credentialId: record.credential.id,
    vaultId: record.credential.vaultId,
    credentialSource: source,
  };
}

/**
 * MCP proxy target for a managed Session's MCP server: the first active
 * `mcp_oauth` / `static_bearer` credential (in Vault order) whose
 * `mcpServerUrl` equals the server URL.
 */
export function selectManagedMcpTarget(
  records: readonly ManagedProxyCredentialRecord[],
  serverUrl: string,
  source: McpProxyCredentialSource,
): ManagedProxyTarget | null {
  for (const record of records) {
    const { credential } = record;
    if (credential.archivedAt !== null) continue;
    if (mcpServerUrlOf(credential.auth) !== serverUrl) continue;
    const token = bearerOf(credential.auth);
    if (token === null) continue;
    const refresh = mcpOAuthRefresh(record, source);
    return { upstreamUrl: serverUrl, upstreamToken: token, ...(refresh && { refresh }) };
  }
  return null;
}

/**
 * Outbound (sandbox egress) target for `hostname`.
 *
 * 1. A CLI spec claims the host: the newest active `cap_cli` credential with
 *    that spec's `cliId` wins (re-auth leaves older rows behind).
 * 2. Otherwise the newest active MCP credential whose `mcpServerUrl` host
 *    equals `hostname`.
 */
export function selectManagedOutboundTarget(
  records: readonly ManagedProxyCredentialRecord[],
  hostname: string,
  registry: SpecRegistry,
  source: McpProxyCredentialSource,
): ManagedProxyTarget | null {
  const spec = registry.byHostname(hostname);
  if (spec !== null) {
    let best: { record: ManagedProxyCredentialRecord; token: string; ts: number } | null = null;
    for (const record of records) {
      const { credential } = record;
      const auth = credential.auth;
      if (credential.archivedAt !== null || auth.type !== "cap_cli") continue;
      if (auth.cliId !== spec.cli_id || !auth.token) continue;
      const ts = timestamp(credential);
      if (best === null || ts > best.ts) best = { record, token: auth.token, ts };
    }
    if (best !== null) {
      const refresh = capCliRefresh(best.record, spec, source);
      return {
        upstreamUrl: `https://${hostname}/`,
        upstreamToken: best.token,
        ...(refresh && { refresh }),
      };
    }
  }

  let best: { record: ManagedProxyCredentialRecord; url: string; token: string; ts: number } | null = null;
  for (const record of records) {
    const { credential } = record;
    if (credential.archivedAt !== null) continue;
    const url = mcpServerUrlOf(credential.auth);
    if (url === null) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (host !== hostname) continue;
    const token = bearerOf(credential.auth);
    if (token === null) continue;
    const ts = timestamp(credential);
    if (best === null || ts > best.ts) best = { record, url, token, ts };
  }
  if (best === null) return null;
  const refresh = mcpOAuthRefresh(best.record, source);
  return { upstreamUrl: best.url, upstreamToken: best.token, ...(refresh && { refresh }) };
}

/**
 * Sandbox placeholder environment for a managed Session: each active
 * `cap_cli` credential contributes its CLI spec's `bootstrap.env` (e.g.
 * `GITHUB_TOKEN=__cap_managed__`) so CLIs that refuse to start without a
 * token still dial out; the egress proxy swaps in the real token. Tokens
 * themselves never appear here. The first credential to set a name wins.
 */
export function capCliBootstrapEnvironment(
  records: readonly ManagedProxyCredentialRecord[],
  registry: SpecRegistry,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { credential } of records) {
    const auth = credential.auth;
    if (credential.archivedAt !== null || auth.type !== "cap_cli") continue;
    const spec = registry.byCliId(auth.cliId);
    if (spec === null) {
      throw new Error(`cap_cli credential ${credential.id} names unknown cli_id "${auth.cliId}"`);
    }
    for (const [name, value] of Object.entries(spec.bootstrap?.env ?? {})) {
      if (!(name in env)) env[name] = value;
    }
  }
  return env;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}

/**
 * The credential with freshly issued tokens, or null when its type has no
 * refreshable token (the caller then keeps the issued token unsaved).
 */
export function applyManagedRotation(
  credential: Credential,
  tokens: IssuedTokens,
  updatedAt: string,
): Credential | null {
  const auth = credential.auth;
  switch (auth.type) {
    case "mcp_oauth":
      if (auth.refresh == null) return null;
      return {
        ...credential,
        updatedAt,
        auth: {
          ...auth,
          accessToken: tokens.accessToken,
          ...(tokens.expiresAt !== null && { expiresAt: tokens.expiresAt }),
          refresh: {
            ...auth.refresh,
            ...(tokens.refreshToken !== null && { refreshToken: tokens.refreshToken }),
          },
        },
      };
    case "cap_cli":
      return {
        ...credential,
        updatedAt,
        auth: {
          ...auth,
          token: tokens.accessToken,
          ...(tokens.expiresAt !== null && { expiresAt: tokens.expiresAt }),
          ...(tokens.refreshToken !== null && { refreshToken: tokens.refreshToken }),
        },
      };
    case "static_bearer":
    case "environment_variable":
      return null;
  }
}

/** The token currently stored for a credential, for refresh dedup. */
export function liveManagedToken(credential: Credential): string | null {
  return bearerOf(credential.auth);
}

export interface TokenEndpointResult {
  type: "issued" | "rejected" | "unreachable";
  tokens?: IssuedTokens;
  oauthError?: string;
}

/** RFC 6749 §6 refresh_token grant. */
export async function exchangeRefreshToken(input: {
  tokenEndpoint: string;
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
}): Promise<TokenEndpointResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId || "open-managed-agents",
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  let res: Response;
  try {
    res = await fetch(input.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
  } catch {
    return { type: "unreachable" };
  }
  if (!res.ok) {
    let oauthError: string | undefined;
    try {
      const payload = (await res.clone().json()) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error.length > 0) {
        oauthError = payload.error;
      }
    } catch {
      /* token endpoint body is not JSON */
    }
    return { type: "rejected", ...(oauthError && { oauthError }) };
  }
  let tokens: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    tokens = (await res.json()) as typeof tokens;
  } catch {
    return { type: "rejected" };
  }
  if (!tokens.access_token) return { type: "rejected" };
  return {
    type: "issued",
    tokens: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt:
        tokens.expires_in !== undefined
          ? new Date(Date.now() + tokens.expires_in * 1_000).toISOString()
          : null,
    },
  };
}

/** Stored refresh token of a refreshable credential, or null. */
function storedRefreshToken(credential: Credential): string | null {
  const auth = credential.auth;
  switch (auth.type) {
    case "mcp_oauth":
      return auth.refresh?.refreshToken || null;
    case "cap_cli":
      return auth.refreshToken || null;
    case "static_bearer":
    case "environment_variable":
      return null;
  }
}

/** Attempts to persist one rotation before giving up. */
const ROTATION_WRITE_ATTEMPTS = 3;

/**
 * Refresh a managed credential after the upstream rejected `staleToken`.
 *
 * The refresh token is read from the current stored record, not from the
 * resolution snapshot. The rotation is written back with `replace`
 * (revision-checked) at the credential's real vault/credential id. A
 * revision conflict only means another writer touched the row: when that
 * writer already rotated the token we use theirs, otherwise this rotation is
 * re-applied on the newer revision. Providers that rotate refresh tokens
 * (GitHub) invalidate the stored one once they issue a new one, so a
 * rotation that cannot be saved is an error, never a silent success.
 *
 * Returns the token to retry with, or null when the provider refused the
 * refresh (the caller surfaces the upstream's 401).
 */
export async function refreshManagedCredential(
  workspaceId: string,
  refresh: ManagedCredentialRefresh,
  staleToken: string,
  failure?: { code: string | null },
): Promise<string | null> {
  const source = refresh.credentialSource;
  const location = {
    workspaceId,
    vaultId: refresh.vaultId,
    credentialId: refresh.credentialId,
  };
  let current = await source.find(location);
  if (current === null) return null;
  // Another call may already have rotated it.
  const live = liveManagedToken(current.credential);
  if (live !== null && live !== staleToken) return live;
  const refreshToken = storedRefreshToken(current.credential);
  if (refreshToken === null) return null;

  const exchanged = await exchangeRefreshToken({
    tokenEndpoint: refresh.tokenEndpoint,
    refreshToken,
    ...(refresh.clientId !== undefined && { clientId: refresh.clientId }),
    ...(refresh.clientSecret !== undefined && { clientSecret: refresh.clientSecret }),
  });
  if (exchanged.type !== "issued") {
    if (failure && failure.code === null && exchanged.oauthError) {
      failure.code = exchanged.oauthError;
    }
    // A parallel refresh may have won and rotated the refresh token.
    const after = await source.find(location);
    const winner = after === null ? null : liveManagedToken(after.credential);
    return winner !== null && winner !== staleToken ? winner : null;
  }
  const tokens = exchanged.tokens!;
  let lastFailure = "revision conflict";
  for (let attempt = 0; attempt < ROTATION_WRITE_ATTEMPTS; attempt += 1) {
    const next = applyManagedRotation(
      current.credential,
      tokens,
      new Date().toISOString(),
    );
    if (next === null) {
      throw new Error(
        `managed credential ${refresh.credentialId} has no refreshable token`,
      );
    }
    let replaced: ManagedCredentialReplaceResult;
    try {
      replaced = await source.replace({
        ...location,
        expectedRevision: current.revision,
        next,
      });
    } catch (error) {
      lastFailure = error instanceof Error ? error.name : "Error";
      const reread = await source.find(location);
      if (reread === null) break;
      current = reread;
      continue;
    }
    if (replaced.type === "replaced") return tokens.accessToken;
    if (replaced.type === "not_found") {
      lastFailure = "credential deleted";
      break;
    }
    const winner = await source.find(location);
    if (winner === null) {
      lastFailure = "credential deleted";
      break;
    }
    const winnerToken = liveManagedToken(winner.credential);
    if (winnerToken !== null && winnerToken !== staleToken) return winnerToken;
    // The conflicting write did not rotate the token: keep ours.
    current = winner;
  }
  throw new Error(
    `managed credential ${refresh.credentialId} refreshed but the rotation could not be saved (${lastFailure})`,
  );
}
