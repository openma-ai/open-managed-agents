/**
 * HTTP implementation of the MCP OAuth protocol port: metadata discovery
 * (RFC 9728 protected resource, RFC 8414 / OIDC authorization server),
 * dynamic client registration (RFC 7591), operator-configured clients for
 * issuers that do not register, the authorization-code exchange, and a
 * `tools/list` probe. Platform neutral: transport and presets are injected.
 */
import type {
  McpOAuthClientResult,
  McpOAuthDiscoveryResult,
  McpOAuthExchangeResult,
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

export class HttpMcpOAuth implements McpOAuthPort {
  constructor(private readonly dependencies: HttpMcpOAuthDependencies) {}

  async discover(mcpServerUrl: string): Promise<McpOAuthDiscoveryResult> {
    try {
      return await this.discoverOrThrow(mcpServerUrl);
    } catch (error) {
      return { type: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async firstJson<T>(candidates: string[]): Promise<{ value: T } | { lastError: string }> {
    let lastError = "";
    for (const candidate of candidates) {
      const response = await this.dependencies.fetch(candidate);
      if (response.ok) return { value: (await response.json()) as T };
      lastError = `${candidate}: ${response.status}`;
    }
    return { lastError };
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
    if (!("value" in resource)) {
      throw new Error(`Failed to fetch Protected Resource Metadata (tried ${resourceCandidates.length}): ${resource.lastError}`);
    }
    const authorizationServer = resource.value.authorization_servers?.[0];
    if (!authorizationServer) throw new Error("No authorization_servers in Protected Resource Metadata");

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
    const found = await this.firstJson<AuthServerMeta>(asmCandidates);
    let authServer: AuthServerMeta | null = "value" in found ? found.value : null;
    // GitHub publishes no authorization server metadata; its endpoints are stable.
    if (authServer === null && /^https:\/\/github\.com\/login\/oauth\/?$/.test(authorizationServer)) {
      authServer = GITHUB_AUTH_SERVER;
    }
    if (authServer === null) {
      throw new Error(`Failed to fetch Auth Server Metadata (tried ${asmCandidates.length}): ${"lastError" in found ? found.lastError : ""}`);
    }
    if (!authServer.authorization_endpoint || !authServer.token_endpoint) {
      throw new Error("Auth Server Metadata missing authorization_endpoint or token_endpoint");
    }
    return {
      type: "discovered",
      metadata: {
        resource: resource.value.resource,
        issuer: authServer.issuer,
        authorizationEndpoint: authServer.authorization_endpoint,
        tokenEndpoint: authServer.token_endpoint,
        scopes: resource.value.scopes_supported ?? [],
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
        message: `${provider.label} MCP OAuth requires a pre-registered ${provider.label} OAuth app: visit ${provider.console}, create one with redirect URL ${input.callbackUri}, then set ${provider.key}_OAUTH_CLIENT_ID and ${provider.key}_OAUTH_CLIENT_SECRET.`,
      };
    }
    return {
      type: "unavailable",
      message: `The MCP server's authorization server ${input.metadata.issuer} does not support Dynamic Client Registration and no preset client is configured for it.`,
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
    } catch (error) {
      return { type: "failed", message: `token endpoint unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!response.ok) {
      return { type: "failed", message: `HTTP ${response.status}: ${(await response.text()).slice(0, 240)}` };
    }
    const tokens = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!tokens.access_token) return { type: "failed", message: "token response has no access_token" };
    return {
      type: "issued",
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt: tokens.expires_in !== undefined
          ? new Date(this.dependencies.clock.now().getTime() + tokens.expires_in * 1_000).toISOString()
          : null,
      },
    };
  }

  async probe(mcpServerUrl: string, accessToken: string): Promise<{ ok: boolean; message?: string }> {
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
      if (response.status >= 200 && response.status < 300) return { ok: true };
      // Vendor guidance (e.g. "enable the app here: <url>") is surfaced verbatim.
      const slice = (await response.text().catch(() => "")).slice(0, 240).trim();
      return { ok: false, message: `MCP probe HTTP ${response.status}${slice ? `: ${slice}` : ""}` };
    } catch (error) {
      return { ok: false, message: `MCP probe failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 120)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

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
