import type { Env, CredentialConfig } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import { builtinSpecs, createSpecRegistry } from "@open-managed-agents/cap";
import type { ManagedCredentialResolver } from "@open-managed-agents/managed-credential-resolver";
import type { BearerMcpTarget, McpProxyTarget } from "@open-managed-agents/http-routes/proxy";

// Pure data and immutable: built once, validated once.
const capRegistry = createSpecRegistry(builtinSpecs);

/** The v1 managed Session fields outbound matching reads. */
interface OutboundSessionSource {
  find(input: { workspaceId: string; sessionId: string }): Promise<{
    archivedAt: string | null;
    vaultIds: readonly string[];
  } | null>;
}

/**
 * Outbound counterpart of the MCP proxy's target resolution: pick a vault bearer
 * token whose `auth.mcp_server_url` shares a hostname with the request the
 * sandbox is about to make. Returns null when the session has no matching
 * credential — caller forwards the request without injection (works for
 * unauthenticated upstreams and matches the pre-refactor "pass through if
 * no match" behavior).
 *
 * Hostname-based match (rather than full URL like the MCP path) because
 * the sandbox container hits arbitrary upstream paths — e.g. the agent
 * configures an MCP server at `https://api.linear.app/mcp` and then
 * fetches `https://api.linear.app/v1/issues/...` from a script. Both
 * should get the same Bearer.
 *
 * Live read on every call: no DO-side snapshot, no KV blob in agent
 * worker. If a vault credential is rotated mid-session, the next outbound
 * call sees the new token without any session-side invalidation.
 */
export async function resolveOutboundCredentialByHost(
  env: Env,
  services: Services,
  tenantId: string,
  sid: string,
  hostname: string,
  sessionSource?: OutboundSessionSource,
  credentialSource?: ManagedCredentialResolver,
): Promise<McpProxyTarget | null> {
  const managedSessionRecord = sessionSource
    ? await sessionSource.find({ workspaceId: tenantId, sessionId: sid }).catch(() => null)
    : null;
  const session = managedSessionRecord
    ?? await services.sessions.get({ tenantId, sessionId: sid }).catch(() => null);
  if (!session) return null;
  const legacySession = session as {
    archived_at?: string | null;
    vault_ids?: string[] | null;
  };
  const managedSession = session as {
    archivedAt?: string | null;
    vaultIds?: readonly string[] | null;
  };
  if (legacySession.archived_at || managedSession.archivedAt) return null;

  const vaultIds: readonly string[] = legacySession.vault_ids ?? managedSession.vaultIds ?? [];
  if (vaultIds.length === 0) return null;
  if (managedSessionRecord !== null && credentialSource !== undefined) {
    const managed = await credentialSource.outboundTarget({ workspaceId: tenantId, sessionId: sid, vaultIds }, hostname);
    return managed === null
      ? null
      : { upstreamUrl: managed.upstreamUrl, upstreamToken: managed.upstreamToken, managed };
  }
  const grouped = await services.credentials.listByVaults({ tenantId, vaultIds: [...vaultIds] }).catch(() => []);

  // First pass: cap_cli credentials matched via cap's spec registry.
  // Cap owns the per-CLI knowledge — endpoints (`api.github.com`,
  // `*.amazonaws.com`, …), header shape, OAuth refresh metadata. Here we
  // just match by hostname → cli_id and find a cap_cli credential whose
  // cli_id matches. Header rewrite happens later, when the target is forwarded.
  //
  // Selection rule when the vault has more than one matching cap_cli
  // (typical after a re-auth): pick the newest non-archived row by
  // `updated_at`. listByVaults returns `created_at ASC` and includes
  // archived rows, so a naive "first match wins" loop kept injecting
  // the OLDEST (= staler) token for sessions whose user re-ran
  // `cap login` to refresh — observed in prod 2026-05-13: gh `repo list`
  // returned 401 even immediately after a successful re-auth.
  const capSpec = capRegistry.byHostname(hostname);
  if (capSpec) {
    let best: { c: typeof grouped[number]["credentials"][number]; vaultId: string; ts: number } | null = null;
    for (const g of grouped) {
      for (const c of g.credentials) {
        if (
          (c as { archived_at?: string | null }).archived_at
          || (c as { archivedAt?: string | null }).archivedAt
        ) continue;
        const auth = (c as unknown as CredentialConfig).auth as
          | {
              type?: string;
              cli_id?: string;
              token?: string;
              refresh_token?: string;
            }
          | undefined;
        if (auth?.type !== "cap_cli") continue;
        if (auth.cli_id !== capSpec.cli_id) continue;
        if (!auth.token) continue;
        const meta = c as { updated_at?: string | number; created_at?: string | number };
        const tsRaw = meta.updated_at ?? meta.created_at ?? 0;
        const ts = typeof tsRaw === "number" ? tsRaw : Date.parse(String(tsRaw)) || 0;
        if (!best || ts > best.ts) best = { c, vaultId: g.vault_id, ts };
      }
    }
    if (best) {
      const auth = (best.c as unknown as CredentialConfig).auth as {
        token?: string;
        refresh_token?: string;
      };
      // Treat every cap_cli credential as a static bearer for the
      // matched hostname. Header-mode CLIs (gh, glab, fly, …) all
      // emit `Authorization: Bearer <token>`, which is what forwarding
      // a target injects. metadata_ep / exec_helper modes
      // need the full cap.handleHttp pipeline — wired in PR 2.
      const target: BearerMcpTarget = {
        upstreamUrl: `https://${hostname}/`,
        upstreamToken: auth.token!,
      };
      // Wire OAuth refresh for cap_cli when the spec declares a
      // device_flow (so we know the token_endpoint + client_id) AND
      // the credential carries a refresh_token. Without this, an
      // expired cap_cli token returns 401 every turn and the user
      // has to manually re-run `cap login` — same problem
      // mcp_oauth had pre-fix. Persistence writes back to
      // `auth.token` (cap_cli's field name), not `auth.access_token`.
      const deviceFlow = capSpec.oauth?.device_flow;
      if (auth.refresh_token && deviceFlow?.token_url) {
        target.refresh = {
          refreshToken: auth.refresh_token,
          tokenEndpoint: deviceFlow.token_url,
          clientId: deviceFlow.client_id,
          credentialId: (best.c as { id: string }).id,
          vaultId: best.vaultId,
          tokenField: "token",
        };
      }
      return target;
    }
  }

  // Second pass: legacy mcp_oauth / static_bearer matched by mcp_server_url.
  // Kept for MCP server credentials (Linear / Slack / Notion etc.) that
  // aren't routed through cap — those are MCP-OAuth, not CLI.
  // Same skip-archived + pick-newest rule as the cap_cli pass above.
  let bestMcp: {
    c: typeof grouped[number]["credentials"][number];
    vaultId: string;
    ts: number;
  } | null = null;
  for (const g of grouped) {
    for (const c of g.credentials) {
      const credential = c as unknown as {
        vaultId?: string;
        vault_id?: string;
        archivedAt?: string | null;
        archived_at?: string | null;
        updatedAt?: string | number;
        updated_at?: string | number;
        createdAt?: string | number;
        created_at?: string | number;
      };
      if (credential.archived_at || credential.archivedAt) continue;
      const auth = (c as unknown as CredentialConfig).auth as
        | {
            type?: string;
            mcp_server_url?: string;
            mcpServerUrl?: string;
            bearer_token?: string;
            token?: string;
            access_token?: string;
            accessToken?: string;
          }
        | undefined;
      if (!auth) continue;
      const mcpServerUrl = auth.mcp_server_url ?? auth.mcpServerUrl;
      if (!mcpServerUrl) continue;
      let credUrl: URL;
      try {
        credUrl = new URL(mcpServerUrl);
      } catch {
        continue;
      }
      if (credUrl.hostname !== hostname) continue;
      const token = auth.bearer_token ?? auth.token ?? auth.access_token ?? auth.accessToken;
      if (!token) continue;
      const tsRaw = credential.updated_at
        ?? credential.updatedAt
        ?? credential.created_at
        ?? credential.createdAt
        ?? 0;
      const ts = typeof tsRaw === "number" ? tsRaw : Date.parse(String(tsRaw)) || 0;
      if (!bestMcp || ts > bestMcp.ts) {
        bestMcp = {
          c,
          vaultId: credential.vaultId ?? credential.vault_id ?? g.vault_id,
          ts,
        };
      }
    }
  }
  if (bestMcp) {
    const auth = (bestMcp.c as unknown as CredentialConfig).auth as {
      type?: string;
      mcp_server_url?: string;
      mcpServerUrl?: string;
      bearer_token?: string;
      token?: string;
      access_token?: string;
      accessToken?: string;
      refresh_token?: string;
      token_endpoint?: string;
      client_id?: string;
      client_secret?: string;
      refresh?: {
        refreshToken?: string | null;
        tokenEndpoint?: string;
        clientId?: string;
        tokenEndpointAuth?: { clientSecret?: string | null };
      } | null;
    };
    const token = auth.bearer_token ?? auth.token ?? auth.access_token ?? auth.accessToken!;
    const mcpServerUrl = auth.mcp_server_url ?? auth.mcpServerUrl!;
    // upstreamUrl on this target is just for forward bookkeeping; the
    // outbound RPC caller passes the actual destination URL it wants
    // hit. We thread the cred's mcp_server_url through so log messages
    // / refresh persistence can correlate, but it's not used by
    // forward's fetch (which uses caller's URL).
    const target: BearerMcpTarget = { upstreamUrl: mcpServerUrl, upstreamToken: token };
    if (auth.type === "mcp_oauth" && auth.refresh_token && auth.token_endpoint) {
      target.refresh = {
        refreshToken: auth.refresh_token,
        tokenEndpoint: auth.token_endpoint,
        clientId: auth.client_id,
        clientSecret: auth.client_secret,
        credentialId: (bestMcp.c as { id: string }).id,
        vaultId: bestMcp.vaultId,
      };
    }
    return target;
  }
  return null;
}
