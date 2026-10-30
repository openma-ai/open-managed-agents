/**
 * Refresh of managed credentials: RFC 6749 refresh-token grant, then a
 * revision-checked write-back of the rotation.
 */
import type {
  CredentialLocation,
  ReplaceCredentialResult,
} from "@open-managed-agents/credential-store";
import type { Credential } from "@open-managed-agents/domain/credentials";
import type { ManagedCredentialResolverPorts } from "./ports";
import { bearerOf, type ManagedCredentialRefresh } from "./selection";

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}

/**
 * The credential with freshly issued tokens, or null when its type has no
 * refreshable token.
 */
export function applyRotation(
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

export interface TokenEndpointResult {
  type: "issued" | "rejected" | "unreachable";
  tokens?: IssuedTokens;
  oauthError?: string;
}

/** RFC 6749 §6 refresh_token grant. */
export async function exchangeRefreshToken(
  ports: Pick<ManagedCredentialResolverPorts, "fetch" | "clock">,
  input: {
    tokenEndpoint: string;
    refreshToken: string;
    clientId?: string;
    clientSecret?: string;
  },
): Promise<TokenEndpointResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.clientId || "open-managed-agents",
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  let res: Response;
  try {
    res = await ports.fetch(input.tokenEndpoint, {
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
          ? new Date(ports.clock.now().getTime() + tokens.expires_in * 1_000).toISOString()
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
 * selection snapshot. The rotation is written back with `replace`
 * (revision-checked). A revision conflict only means another writer touched
 * the row: when that writer already rotated the token we use theirs,
 * otherwise this rotation is re-applied on the newer revision. Providers that
 * rotate refresh tokens invalidate the stored one once they issue a new one,
 * so a rotation that cannot be saved is an error, never a silent success.
 *
 * Returns the token to retry with, or null when the provider refused the
 * refresh (the caller surfaces the upstream's 401).
 */
export async function refreshCredential(
  ports: ManagedCredentialResolverPorts,
  workspaceId: string,
  refresh: ManagedCredentialRefresh,
  staleToken: string,
  failure?: { code: string | null },
): Promise<string | null> {
  const store = ports.credentials;
  const location: CredentialLocation = {
    workspaceId,
    vaultId: refresh.vaultId,
    credentialId: refresh.credentialId,
  };
  let current = await store.find(location);
  if (current === null) return null;
  // Another call may already have rotated it.
  const live = bearerOf(current.credential.auth);
  if (live !== null && live !== staleToken) return live;
  const refreshToken = storedRefreshToken(current.credential);
  if (refreshToken === null) return null;

  const exchanged = await exchangeRefreshToken(ports, {
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
    const after = await store.find(location);
    const winner = after === null ? null : bearerOf(after.credential.auth);
    return winner !== null && winner !== staleToken ? winner : null;
  }
  const tokens = exchanged.tokens!;
  let lastFailure = "revision conflict";
  for (let attempt = 0; attempt < ROTATION_WRITE_ATTEMPTS; attempt += 1) {
    const next = applyRotation(current.credential, tokens, ports.clock.now().toISOString());
    if (next === null) {
      throw new Error(`managed credential ${refresh.credentialId} has no refreshable token`);
    }
    let replaced: ReplaceCredentialResult;
    try {
      replaced = await store.replace({ ...location, expectedRevision: current.revision, next });
    } catch (error) {
      lastFailure = error instanceof Error ? error.name : "Error";
      const reread = await store.find(location);
      if (reread === null) break;
      current = reread;
      continue;
    }
    if (replaced.type === "replaced") return tokens.accessToken;
    if (replaced.type === "not_found") {
      lastFailure = "credential deleted";
      break;
    }
    const winner = await store.find(location);
    if (winner === null) {
      lastFailure = "credential deleted";
      break;
    }
    const winnerToken = bearerOf(winner.credential.auth);
    if (winnerToken !== null && winnerToken !== staleToken) return winnerToken;
    // The conflicting write did not rotate the token: keep ours.
    current = winner;
  }
  throw new Error(
    `managed credential ${refresh.credentialId} refreshed but the rotation could not be saved (${lastFailure})`,
  );
}
