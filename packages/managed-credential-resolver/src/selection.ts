/**
 * Selection of managed (`/v1` Vault) credentials for a Session: MCP servers
 * by server URL, sandbox egress by hostname, and the CLI placeholder
 * environment. Pure functions over stored records.
 */
import type { CapSpec, HeaderInjectSpec, SpecRegistry } from "@open-managed-agents/cap";
import type { StoredCredential } from "@open-managed-agents/credential-store";
import type { Credential, CredentialAuth } from "@open-managed-agents/domain/credentials";

/** Where and how a selected credential is refreshed. */
export interface ManagedCredentialRefresh {
  credentialId: string;
  vaultId: string;
  tokenEndpoint: string;
  clientId?: string;
  clientSecret?: string;
}

export interface ManagedCredentialTarget {
  upstreamUrl: string;
  upstreamToken: string;
  header?: HeaderInjectSpec;
  refresh?: ManagedCredentialRefresh;
}

function timestamp(credential: Credential): number {
  return Date.parse(credential.updatedAt) || Date.parse(credential.createdAt) || 0;
}

/** The token a credential injects as a Bearer, or null when it has none. */
export function bearerOf(auth: CredentialAuth): string | null {
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

function mcpOAuthRefresh(credential: Credential): ManagedCredentialRefresh | undefined {
  const auth = credential.auth;
  if (auth.type !== "mcp_oauth" || auth.refresh == null) return undefined;
  if (!auth.refresh.refreshToken || !auth.refresh.tokenEndpoint) return undefined;
  const endpointAuth = auth.refresh.tokenEndpointAuth;
  const clientSecret = endpointAuth.type === "none" ? null : endpointAuth.clientSecret;
  return {
    credentialId: credential.id,
    vaultId: credential.vaultId,
    tokenEndpoint: auth.refresh.tokenEndpoint,
    clientId: auth.refresh.clientId,
    ...(clientSecret ? { clientSecret } : {}),
  };
}

function capCliRefresh(credential: Credential, spec: CapSpec): ManagedCredentialRefresh | undefined {
  const auth = credential.auth;
  if (auth.type !== "cap_cli" || !auth.refreshToken) return undefined;
  const deviceFlow = spec.oauth?.device_flow;
  if (!deviceFlow?.token_url) return undefined;
  return {
    credentialId: credential.id,
    vaultId: credential.vaultId,
    tokenEndpoint: deviceFlow.token_url,
    clientId: deviceFlow.client_id,
  };
}

/**
 * MCP target for a Session's MCP server: the first active `mcp_oauth` /
 * `static_bearer` credential (in Vault order) whose `mcpServerUrl` equals
 * the server URL.
 */
export function selectMcpTarget(
  records: readonly StoredCredential[],
  serverUrl: string,
): ManagedCredentialTarget | null {
  for (const { credential } of records) {
    if (credential.archivedAt !== null) continue;
    if (mcpServerUrlOf(credential.auth) !== serverUrl) continue;
    const token = bearerOf(credential.auth);
    if (token === null) continue;
    const refresh = mcpOAuthRefresh(credential);
    return { upstreamUrl: serverUrl, upstreamToken: token, ...(refresh && { refresh }) };
  }
  return null;
}

/**
 * Sandbox egress target for `hostname`.
 *
 * 1. A CLI spec claims the host: the newest active `cap_cli` credential with
 *    that spec's `cliId` wins (re-auth leaves older rows behind).
 * 2. Otherwise the newest active MCP credential whose `mcpServerUrl` host
 *    equals `hostname`.
 */
export function selectOutboundTarget(
  records: readonly StoredCredential[],
  hostname: string,
  registry: SpecRegistry,
): ManagedCredentialTarget | null {
  const spec = registry.byHostname(hostname);
  if (spec !== null) {
    let best: { credential: Credential; token: string; ts: number } | null = null;
    for (const { credential } of records) {
      const auth = credential.auth;
      if (credential.archivedAt !== null || auth.type !== "cap_cli") continue;
      if (auth.cliId !== spec.cli_id || !auth.token) continue;
      const ts = timestamp(credential);
      if (best === null || ts > best.ts) best = { credential, token: auth.token, ts };
    }
    if (best !== null) {
      const refresh = capCliRefresh(best.credential, spec);
      return {
        upstreamUrl: `https://${hostname}/`,
        upstreamToken: best.token,
        ...(spec.inject_mode === "header" && spec.header ? { header: spec.header } : {}),
        ...(refresh && { refresh }),
      };
    }
  }

  let best: { credential: Credential; url: string; token: string; ts: number } | null = null;
  for (const { credential } of records) {
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
    if (best === null || ts > best.ts) best = { credential, url, token, ts };
  }
  if (best === null) return null;
  const refresh = mcpOAuthRefresh(best.credential);
  return { upstreamUrl: best.url, upstreamToken: best.token, ...(refresh && { refresh }) };
}

/**
 * Sandbox placeholder environment: each active `cap_cli` credential
 * contributes its CLI spec's `bootstrap.env` (e.g. `GITHUB_TOKEN=__cap_managed__`)
 * so CLIs that refuse to start without a token still dial out; the egress
 * proxy swaps in the real token. Tokens never appear here. The first
 * credential to set a name wins.
 */
export function placeholderEnvironment(
  records: readonly StoredCredential[],
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
