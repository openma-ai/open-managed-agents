import { refreshMcpOAuth } from "@open-managed-agents/vault-forward";
import type { CredentialAuth } from "@open-managed-agents/shared";
import type { LegacyMcpCredentialsPort } from "./mcp-proxy-ports";

/** Refresh metadata of a legacy `/v1/oma` Vault credential. */
export interface LegacyCredentialRefresh {
  refreshToken: string;
  tokenEndpoint: string;
  clientId?: string;
  clientSecret?: string;
  credentialId: string;
  vaultId: string;
  /** Auth field holding the access token: mcp_oauth `access_token` (the
   * default), cap_cli `token`. Read and written back under this name. */
  tokenField?: "access_token" | "token";
}

/**
 * A token to retry with after the upstream rejected `staleToken`, or null.
 *
 * Concurrent 401s on one credential are common (a TTL boundary in the middle
 * of parallel tool calls), so the stored row is re-read first: if its token
 * already moved past `staleToken`, another call refreshed it and that token
 * is used without calling the token endpoint. Otherwise the refresh token is
 * exchanged and the rotation is written back with compare-and-swap on the
 * row's auth ciphertext (AES-GCM uses a random IV, so equal bytes mean the row
 * is unchanged). A lost CAS, or a refused exchange whose refresh token a
 * concurrent winner already rotated, falls back to the winner's token.
 */
export async function refreshLegacyCredential(
  ports: { credentials: LegacyMcpCredentialsPort; fetch?: typeof fetch },
  workspaceId: string,
  refresh: LegacyCredentialRefresh,
  staleToken: string,
  failure?: { code: string | null },
): Promise<string | null> {
  const tokenField = refresh.tokenField ?? "access_token";
  const row = { tenantId: workspaceId, vaultId: refresh.vaultId, credentialId: refresh.credentialId };
  const storedToken = async (): Promise<string | null> => {
    const current = await ports.credentials.get(row).catch(() => null);
    const value = (current?.auth as unknown as Record<string, unknown> | undefined)?.[tokenField];
    return typeof value === "string" ? value : null;
  };

  let expectedAuthCipher: string | null = null;
  const raw = await ports.credentials.getRawForRefresh(row).catch(() => null);
  if (raw !== null) {
    const live = (raw.row.auth as unknown as Record<string, unknown> | undefined)?.[tokenField];
    if (typeof live === "string" && live !== staleToken) return live;
    expectedAuthCipher = raw.authCipher;
  }

  const fetcher = ports.fetch ?? ((input, init) => fetch(input, init));
  const tokens = await refreshMcpOAuth(refresh, fetcher, failure);
  if (tokens === null) {
    const winner = await storedToken();
    return winner !== null && winner !== staleToken ? winner : null;
  }

  const auth = {
    [tokenField]: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined,
  } as Partial<CredentialAuth>;
  if (expectedAuthCipher === null) {
    // The read failed: persist without CAS rather than not at all.
    await ports.credentials.refreshAuth({ ...row, auth }).catch(() => null);
    return tokens.access_token;
  }
  const updated = await ports.credentials
    .refreshAuthCAS({ ...row, expectedAuthCipher, auth })
    .catch(() => null);
  if (updated !== null) return tokens.access_token;
  // CAS lost: the winner's token is as valid as ours and is the stored one.
  return (await storedToken()) ?? tokens.access_token;
}
