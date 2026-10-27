// Pure functions for credential resolution + outbound injection.
//
// Callers: the Node MCP proxy (packages/control-plane-node) and the vault
// routes (packages/http-routes). They share: hostname-match a credential,
// build the right header, and on 401 with mcp_oauth refresh and retry
// once. The HTTP hop itself is the caller's (`ForwardOpts.send`).

import type { CredentialAuth, CredentialConfig } from "@open-managed-agents/shared";

export interface ResolvedCredential {
  /** Internal id for log correlation; never sent on the wire. */
  credentialId: string;
  vaultId: string;
  /** Auth payload as stored. Refresh metadata extracted by the caller
   *  via {@link refreshMetadataOf}. */
  auth: CredentialAuth;
}

export interface AuthHeader {
  name: string;
  value: string;
}

export interface OauthRefreshMetadata {
  refreshToken: string;
  tokenEndpoint: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Build the Authorization (or other) header for a credential. Returns
 * null when the credential isn't header-injectable (e.g. cap_cli in
 * exec_helper mode — its outbound path goes through cap.handleHttp,
 * not a simple header inject).
 */
export function buildAuthHeader(auth: CredentialAuth): AuthHeader | null {
  switch (auth.type) {
    case "static_bearer":
      if (typeof auth.token === "string" && auth.token.length > 0) {
        return { name: "authorization", value: `Bearer ${auth.token}` };
      }
      return null;
    case "cap_cli":
      // Header-mode CLIs (gh, glab, fly) all emit Authorization: Bearer.
      // metadata_ep / exec_helper modes need cap.handleHttp — caller owns
      // detection of those.
      if (typeof auth.token === "string" && auth.token.length > 0) {
        return { name: "authorization", value: `Bearer ${auth.token}` };
      }
      return null;
    case "mcp_oauth": {
      const t = (auth as { access_token?: string; bearer_token?: string; token?: string })
        .access_token ??
        (auth as { bearer_token?: string }).bearer_token ??
        (auth as { token?: string }).token;
      if (typeof t === "string" && t.length > 0) {
        return { name: "authorization", value: `Bearer ${t}` };
      }
      return null;
    }
    default:
      return null;
  }
}

/** Extract refresh metadata from an mcp_oauth credential. Returns null
 *  for any other type, or when the refresh fields are absent. */
export function refreshMetadataOf(auth: CredentialAuth): OauthRefreshMetadata | null {
  if (auth.type !== "mcp_oauth") return null;
  const a = auth as {
    refresh_token?: string;
    token_endpoint?: string;
    client_id?: string;
    client_secret?: string;
  };
  if (!a.refresh_token || !a.token_endpoint) return null;
  return {
    refreshToken: a.refresh_token,
    tokenEndpoint: a.token_endpoint,
    clientId: a.client_id,
    clientSecret: a.client_secret,
  };
}

/**
 * Find the active credential whose mcp_server_url host matches `host`.
 * Hostname-only match — caller may also pass a path-aware preselector for
 * cap_cli (registry.byHostname) by handing in a pre-filtered grouped list.
 *
 * `groupedCredentials` is the shape services.credentials.listByVaults
 * returns: [{ vault_id, credentials: [...] }, ...]. Pass an empty array
 * when no vaults are bound (we return null without iterating).
 */
export function pickCredentialByHost(
  groupedCredentials: Array<{
    vault_id: string;
    credentials: Array<{ id: string; auth: CredentialAuth | unknown }>;
  }>,
  host: string,
): ResolvedCredential | null {
  for (const g of groupedCredentials) {
    for (const c of g.credentials) {
      const auth = c.auth as CredentialAuth | undefined;
      const url = (auth as { mcp_server_url?: string } | undefined)?.mcp_server_url;
      if (!url) continue;
      let credHost: string;
      try {
        credHost = new URL(url).host;
      } catch {
        continue;
      }
      if (credHost !== host) continue;
      return { credentialId: c.id, vaultId: g.vault_id, auth: auth as CredentialAuth };
    }
  }
  return null;
}

/**
 * POST refresh_token to the token_endpoint, return the new tokens.
 * Pure: no DB writes, no logging. Caller persists the rotated value
 * (services.credentials.refreshAuth or equivalent) and decides whether
 * to retry the upstream request.
 */
export interface RefreshedTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

export async function refreshMcpOAuth(
  meta: OauthRefreshMetadata,
  fetcher: typeof fetch = fetch,
  failure?: { code: string | null },
): Promise<RefreshedTokens | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: meta.refreshToken,
    client_id: meta.clientId || "open-managed-agents",
  });
  if (meta.clientSecret) body.set("client_secret", meta.clientSecret);

  let res: Response;
  try {
    res = await fetcher(meta.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    return null;
  }
  if (!res.ok) {
    if (failure && failure.code === null) {
      try {
        const payload = await res.clone().json() as { error?: unknown };
        if (typeof payload.error === "string" && payload.error.length > 0) {
          failure.code = payload.error;
        }
      } catch {
        /* token endpoint body is not JSON */
      }
    }
    return null;
  }

  let tokens: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    tokens = (await res.json()) as typeof tokens;
  } catch {
    return null;
  }
  if (!tokens.access_token) return null;
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? meta.refreshToken,
    expires_in: tokens.expires_in,
  };
}

/**
 * Run one upstream attempt with the credential's access token and, on a
 * 401 from a refreshable credential, refresh once and retry with the
 * rotated token. The caller owns the HTTP hop (`send`): this package
 * decides *when* to retry and with which token, never *how* to send, so
 * header hygiene lives in one place (the HTTP route layer).
 *
 * `send` is called more than once, so it must replay a buffered body.
 */
export interface ForwardOpts {
  /** One upstream attempt with `accessToken` injected. */
  send: (accessToken: string) => Promise<Response>;
  /** Active access token from the credential (or `auth.token`). Used as
   *  the first attempt. */
  accessToken: string;
  /** When set, a 401 triggers refresh + retry once. Caller persists the
   *  rotated tokens via `onRefreshed`. */
  refresh?: OauthRefreshMetadata;
  /** Called after a successful refresh so the runtime can persist the
   *  new tokens (re-encrypted) back to the canonical credential row. */
  onRefreshed?: (t: RefreshedTokens) => Promise<void>;
  /** Transport for the token endpoint. Defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Called with the final upstream response, after a refresh attempt. */
  onFinal?: (info: {
    status: number;
    bodyText: string;
    refreshed: boolean;
    refreshFailed: boolean;
    refreshFailureCode: string | null;
  }) => Promise<void>;
}

export async function forwardWithRefresh(opts: ForwardOpts): Promise<Response> {
  const fetcher = opts.fetcher ?? fetch;
  const send = opts.send;

  const finish = async (
    response: Response,
    info: {
      refreshed: boolean;
      refreshFailed: boolean;
      refreshFailureCode: string | null;
    },
  ): Promise<Response> => {
    if (!opts.onFinal) return response;
    const bodyText = await response.text();
    await opts.onFinal({ status: response.status, bodyText, ...info });
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return new Response(bodyText, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  const first = await send(opts.accessToken);
  if (first.status !== 401 || !opts.refresh) {
    return finish(first, {
      refreshed: false,
      refreshFailed: false,
      refreshFailureCode: null,
    });
  }

  // Drain the body so we can return a fresh Response without two
  // outstanding streams.
  try {
    await first.body?.cancel();
  } catch {
    /* already consumed / closed */
  }

  const refreshFailure: { code: string | null } = { code: null };
  const refreshed = await refreshMcpOAuth(opts.refresh, fetcher, refreshFailure);
  if (!refreshed) {
    // Refresh failed — re-issue with the original token to surface the
    // upstream's actual 401 (matches old apps/main behavior).
    return finish(await send(opts.accessToken), {
      refreshed: false,
      refreshFailed: true,
      refreshFailureCode: refreshFailure.code,
    });
  }
  if (opts.onRefreshed) {
    try {
      await opts.onRefreshed(refreshed);
    } catch {
      // Best-effort; caller has the new token regardless.
    }
  }
  return finish(await send(refreshed.access_token), {
    refreshed: true,
    refreshFailed: false,
    refreshFailureCode: null,
  });
}

// Re-export the credentials-store's CredentialConfig for convenience —
// callers usually have it from services.credentials.listByVaults.
export type { CredentialConfig };
