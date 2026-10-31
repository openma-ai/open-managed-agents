/**
 * HTTP implementation of the MCP OAuth protocol port: metadata discovery
 * (RFC 9728 protected resource, RFC 8414 / OIDC authorization server),
 * dynamic client registration (RFC 7591), operator-configured clients for
 * issuers that do not register, the authorization-code exchange, and a
 * `tools/list` probe. Platform neutral: transport and presets are injected.
 */
import type {
  McpOAuthCliSecrets,
  McpOAuthClientResult,
  McpOAuthDiscoveryResult,
  McpOAuthExchangeResult,
  McpOAuthFailureReason,
  McpOAuthPkce,
  McpOAuthPort,
  McpOAuthServerMetadata,
} from "@open-managed-agents/managed-agents-application";

/** OAuth client an operator registered with a provider that has no DCR. */
export interface McpOAuthPresetClient {
  clientId: string;
  clientSecret: string;
}

/**
 * Providers whose authorization servers do not accept dynamic registration
 * for arbitrary redirect URIs. Keys name the operator configuration
 * (`<KEY>_OAUTH_CLIENT_ID` / `_SECRET`).
 */
export const MCP_OAUTH_PRESET_PROVIDERS = [
  { key: "GITHUB", issuer: /^https:\/\/github\.com\/login\/oauth\/?$/, label: "GitHub", console: "https://github.com/settings/developers" },
  { key: "FEISHU", issuer: /^https:\/\/accounts\.feishu\.cn\//, label: "Feishu", console: "https://open.feishu.cn" },
  { key: "LARK", issuer: /^https:\/\/accounts\.larksuite\.com\//, label: "Lark", console: "https://open.larksuite.com" },
  { key: "ASANA", issuer: /^https:\/\/app\.asana\.com\/?$/, label: "Asana", console: "https://app.asana.com/0/my-apps" },
  { key: "CLICKUP", issuer: /^https:\/\/mcp\.clickup\.com\/?$/, label: "ClickUp", console: "https://app.clickup.com/settings/apps" },
  { key: "SLACK", issuer: /^https:\/\/slack\.com\/?$/, label: "Slack", console: "https://api.slack.com/apps" },
] as const;

export type McpOAuthPresetKey = (typeof MCP_OAUTH_PRESET_PROVIDERS)[number]["key"];

/** Preset clients from `<KEY>_OAUTH_CLIENT_ID` / `<KEY>_OAUTH_CLIENT_SECRET`. */
export function mcpOAuthPresetsFromEnvironment(
  environment: Record<string, string | undefined>,
): Partial<Record<McpOAuthPresetKey, McpOAuthPresetClient>> {
  const presets: Partial<Record<McpOAuthPresetKey, McpOAuthPresetClient>> = {};
  for (const { key } of MCP_OAUTH_PRESET_PROVIDERS) {
    const clientId = environment[`${key}_OAUTH_CLIENT_ID`];
    const clientSecret = environment[`${key}_OAUTH_CLIENT_SECRET`];
    if (clientId && clientSecret) presets[key] = { clientId, clientSecret };
  }
  return presets;
}

/**
 * Comma-separated `CONSOLE_ORIGINS` (deployment configuration, same name on
 * Cloudflare and Node) as canonical origins. A malformed entry fails.
 */
export function parseConsoleOrigins(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`CONSOLE_ORIGINS entry "${entry}" must be an http(s) origin`);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== entry.replace(/\/+$/, "")) {
      throw new Error(`CONSOLE_ORIGINS entry "${entry}" must be an http(s) origin`);
    }
    return url.origin;
  });
}

export interface HttpMcpOAuthDependencies {
  fetch: typeof fetch;
  clock: { now(): Date };
  presets: Partial<Record<McpOAuthPresetKey, McpOAuthPresetClient>>;
  log?: { warn(fields: Record<string, unknown>, message: string): void };
}

interface ProtectedResourceMeta {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface AuthServerMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

const GITHUB_AUTH_SERVER: AuthServerMeta = {
  issuer: "https://github.com/login/oauth",
  authorization_endpoint: "https://github.com/login/oauth/authorize",
  token_endpoint: "https://github.com/login/oauth/access_token",
};

const PROBE_TIMEOUT_MS = 5_000;

class DiscoveryError extends Error {
  constructor(readonly reason: McpOAuthFailureReason) {
    super(reason);
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export class HttpMcpOAuth implements McpOAuthPort {
  constructor(private readonly dependencies: HttpMcpOAuthDependencies) {}

  async discover(mcpServerUrl: string): Promise<McpOAuthDiscoveryResult> {
    try {
      return await this.discoverOrThrow(mcpServerUrl);
    } catch (error) {
      const reason: McpOAuthFailureReason = error instanceof DiscoveryError ? error.reason : "upstream_unreachable";
      // Server-side detail stays a host and a code: no URLs or bodies.
      this.warn("mcp_oauth.discovery_failed", { host: hostOf(mcpServerUrl), reason });
      return { type: "failed", reason };
    }
  }

  private warn(op: string, fields: Record<string, unknown>): void {
    this.dependencies.log?.warn({ op, ...fields }, "MCP OAuth upstream call failed");
  }

  private async firstJson<T>(candidates: string[]): Promise<T | null> {
    for (const candidate of candidates) {
      const response = await this.dependencies.fetch(candidate);
      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch {
          throw new DiscoveryError("metadata_invalid");
        }
      }
      await response.body?.cancel();
    }
    return null;
  }

  private async discoverOrThrow(mcpServerUrl: string): Promise<McpOAuthDiscoveryResult> {
    const url = new URL(mcpServerUrl);
    // RFC 9728 §3.1 path-based metadata first, then origin-only.
    const path = url.pathname.replace(/\/+$/, "");
    const resourceCandidates = [
      ...(path ? [`${url.origin}/.well-known/oauth-protected-resource${path}`] : []),
      `${url.origin}/.well-known/oauth-protected-resource`,
    ];
    const resource = await this.firstJson<ProtectedResourceMeta>(resourceCandidates);
    if (resource === null) throw new DiscoveryError("metadata_unavailable");
    const authorizationServer = resource.authorization_servers?.[0];
    if (!authorizationServer || typeof resource.resource !== "string") {
      throw new DiscoveryError("metadata_invalid");
    }

    // RFC 8414 §3 inserts the well-known segment between origin and path;
    // OIDC discovery and the legacy issuer-suffix form are also probed.
    const issuer = new URL(authorizationServer);
    const issuerPath = issuer.pathname.replace(/\/+$/, "");
    const asmCandidates = [
      ...(issuerPath
        ? [
            `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
            `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
          ]
        : []),
      `${issuer.origin}/.well-known/oauth-authorization-server`,
      `${issuer.origin}/.well-known/openid-configuration`,
      `${authorizationServer}/.well-known/oauth-authorization-server`,
    ];
    let authServer = await this.firstJson<AuthServerMeta>(asmCandidates);
    // GitHub publishes no authorization server metadata; its endpoints are stable.
    if (authServer === null && /^https:\/\/github\.com\/login\/oauth\/?$/.test(authorizationServer)) {
      authServer = GITHUB_AUTH_SERVER;
    }
    if (authServer === null) throw new DiscoveryError("metadata_unavailable");
    if (!authServer.authorization_endpoint || !authServer.token_endpoint) {
      throw new DiscoveryError("metadata_invalid");
    }
    return {
      type: "discovered",
      metadata: {
        resource: resource.resource,
        issuer: authServer.issuer,
        authorizationEndpoint: authServer.authorization_endpoint,
        tokenEndpoint: authServer.token_endpoint,
        scopes: resource.scopes_supported ?? [],
      },
      ...(authServer.registration_endpoint && { registrationEndpoint: authServer.registration_endpoint }),
    };
  }

  async client(input: {
    metadata: McpOAuthServerMetadata;
    registrationEndpoint?: string;
    callbackUri: string;
  }): Promise<McpOAuthClientResult> {
    if (input.registrationEndpoint !== undefined) {
      const registered = await this.register(input.registrationEndpoint, input.callbackUri);
      if (registered !== null) return { type: "client", client: registered };
    }
    const provider = MCP_OAUTH_PRESET_PROVIDERS.find((candidate) => candidate.issuer.test(input.metadata.issuer));
    if (provider !== undefined) {
      const preset = this.dependencies.presets[provider.key];
      if (preset !== undefined) {
        return { type: "client", client: { clientId: preset.clientId, clientSecret: preset.clientSecret } };
      }
      return {
        type: "unavailable",
        message: `${provider.label} MCP OAuth requires a pre-registered ${provider.label} OAuth app: visit ${provider.console}, register this service's /v1/oma/oauth/callback as the redirect URI, then set ${provider.key}_OAUTH_CLIENT_ID and ${provider.key}_OAUTH_CLIENT_SECRET.`,
      };
    }
    return {
      type: "unavailable",
      message: "The MCP server's authorization server does not support Dynamic Client Registration and no preset client is configured for it.",
    };
  }

  private async register(
    registrationEndpoint: string,
    callbackUri: string,
  ): Promise<{ clientId: string; clientSecret?: string } | null> {
    try {
      const response = await this.dependencies.fetch(registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Open Managed Agents",
          redirect_uris: [callbackUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { client_id?: string; client_secret?: string };
      if (!data.client_id) return null;
      return { clientId: data.client_id, ...(data.client_secret && { clientSecret: data.client_secret }) };
    } catch (error) {
      // Registration failure falls through to presets; keep it visible.
      this.dependencies.log?.warn(
        { op: "mcp_oauth.dcr_register", error: error instanceof Error ? error.name : "Error" },
        "MCP OAuth dynamic client registration failed",
      );
      return null;
    }
  }

  async exchangeCode(input: {
    tokenEndpoint: string;
    code: string;
    codeVerifier: string;
    callbackUri: string;
    resource: string;
    client: { clientId: string; clientSecret?: string };
  }): Promise<McpOAuthExchangeResult> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.callbackUri,
      client_id: input.client.clientId,
      code_verifier: input.codeVerifier,
      resource: input.resource,
    });
    if (input.client.clientSecret) body.set("client_secret", input.client.clientSecret);
    let response: Response;
    try {
      response = await this.dependencies.fetch(input.tokenEndpoint, {
        method: "POST",
        // GitHub answers form-encoded unless JSON is requested.
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
      });
    } catch {
      this.warn("mcp_oauth.exchange_failed", { host: hostOf(input.tokenEndpoint), reason: "upstream_unreachable" });
      return { type: "failed", reason: "upstream_unreachable" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      this.warn("mcp_oauth.exchange_failed", {
        host: hostOf(input.tokenEndpoint),
        reason: "upstream_rejected",
        status: response.status,
      });
      return { type: "failed", reason: "upstream_rejected" };
    }
    let tokens: { access_token?: string; refresh_token?: string; expires_in?: number };
    try {
      tokens = (await response.json()) as typeof tokens;
    } catch {
      return { type: "failed", reason: "upstream_invalid_response" };
    }
    if (
      tokens === null || typeof tokens !== "object"
      || typeof tokens.access_token !== "string" || tokens.access_token.length === 0
      || (tokens.refresh_token !== undefined && typeof tokens.refresh_token !== "string")
      || (tokens.expires_in !== undefined && (typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in < 0))
    ) return { type: "failed", reason: "upstream_invalid_response" };
    const expiresAt = tokens.expires_in === undefined
      ? null
      : new Date(this.dependencies.clock.now().getTime() + tokens.expires_in * 1_000);
    if (expiresAt !== null && !Number.isFinite(expiresAt.getTime())) {
      return { type: "failed", reason: "upstream_invalid_response" };
    }
    return {
      type: "issued",
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    };
  }

  async probe(mcpServerUrl: string, accessToken: string): Promise<{ ok: boolean; reason?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await this.dependencies.fetch(mcpServerUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        signal: controller.signal,
      });
      await response.body?.cancel();
      if (response.status >= 200 && response.status < 300) return { ok: true };
      return { ok: false, reason: `http_${response.status}` };
    } catch {
      return { ok: false, reason: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const webCryptoMcpOAuthCliSecrets: McpOAuthCliSecrets = {
  randomToken: () => base64Url(crypto.getRandomValues(new Uint8Array(32))),
  hash: async (value) => base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))),
};

/** RFC 7636 S256 PKCE over Web Crypto. */
export const webCryptoMcpOAuthPkce: McpOAuthPkce = {
  async create() {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    const verifier = base64Url(bytes);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: base64Url(new Uint8Array(digest)) };
  },
};

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
