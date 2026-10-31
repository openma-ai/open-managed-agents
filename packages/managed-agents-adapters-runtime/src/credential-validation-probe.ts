import type {
  CredentialAuth,
  CredentialValidationProbe,
  CredentialValidationProbePort,
  CredentialValidationRotation,
  CredentialResponseObservation,
  ProbeCredentialValidation,
} from "@open-managed-agents/managed-agents-application";

const INITIALIZE_METHOD = "initialize";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_READ_BYTES = 65_536;
const MAX_OBSERVATION_CHARS = 4_096;
const TEN_YEARS_SECONDS = 10 * 365 * 24 * 60 * 60;
const REDACTED = "[redacted]";

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: "credential-validation",
  method: INITIALIZE_METHOD,
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: {
      name: "open-managed-agents",
      version: "credential-validation",
    },
  },
});

export interface McpOAuthCredentialValidationProbeOptions {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  clock?: { now(): Date };
  timeoutMs?: number;
}

interface ParsedToken {
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  expiresIn: number | null;
  oauthError: string | null;
}

interface Exchange {
  statusCode: number;
  contentType: string;
  rawBody: string;
  truncated: boolean;
}

type McpOutcome = "accepted" | "rejected" | "transient" | "unclear";

/**
 * Live MCP OAuth credential probe shared by the Node and Cloudflare runtimes.
 *
 * `valid` means the MCP server accepted the bearer. `invalid` means the
 * server rejected it and a refresh, when one was possible, did not recover
 * access (expired or revoked). `indeterminate` means the probe could not
 * decide — a transport failure, 429, or 5xx. Observations are scrubbed.
 * Issued tokens are kept on a non-enumerable `rotation` property for the
 * application to persist; they are not placed on the public view.
 */
export class McpOAuthCredentialValidationProbe
  implements CredentialValidationProbePort
{
  private readonly fetchImpl: (
    input: string,
    init?: RequestInit,
  ) => Promise<Response>;
  private readonly clock: { now(): Date };
  private readonly timeoutMs: number;

  constructor(options: McpOAuthCredentialValidationProbeOptions = {}) {
    this.fetchImpl =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.clock = options.clock ?? { now: () => new Date() };
    const timeout = options.timeoutMs;
    this.timeoutMs =
      typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
        ? timeout
        : DEFAULT_TIMEOUT_MS;
  }

  async validate(
    input: ProbeCredentialValidation,
  ): Promise<CredentialValidationProbe> {
    rejectCapCli(input.credential.auth);
    try {
      return await this.inspect(input);
    } catch {
      return sealProbe({
        hasRefreshToken: hasRefreshToken(input.credential.auth),
        mcpProbe: null,
        refresh: null,
        status: "indeterminate",
      });
    }
  }

  private async inspect(
    input: ProbeCredentialValidation,
  ): Promise<CredentialValidationProbe> {
    const auth = input.credential.auth;
    const secrets: string[] = [];
    collectSecrets(auth, secrets);
    const base = {
      hasRefreshToken: hasRefreshToken(auth),
      mcpProbe: null,
      refresh: null,
      status: "indeterminate" as const,
    };
    const mcpUrl = mcpEndpoint(auth);
    if (mcpUrl === null) return sealProbe(base);
    const parsedMcp = parseHttpUrl(mcpUrl);
    if (parsedMcp === null) return sealProbe(base);

    const first = await this.exchange(
      parsedMcp,
      INITIALIZE_BODY,
      mcpHeaders(bearerToken(auth)),
    );
    if (first === null) {
      return sealProbe({
        ...base,
        mcpProbe: { method: INITIALIZE_METHOD, response: null },
      });
    }
    const firstOutcome = classifyMcp(first.statusCode);
    if (firstOutcome === "accepted") return sealProbe({ ...base, status: "valid" });
    const firstObservation = observationOf(first, secrets);
    if (firstOutcome !== "rejected") {
      return sealProbe({
        ...base,
        mcpProbe: { method: INITIALIZE_METHOD, response: firstObservation },
      });
    }

    const rejected = {
      method: INITIALIZE_METHOD,
      response: firstObservation,
    };
    const refresh = await this.refresh(auth, secrets);
    if (refresh.type === "no_refresh_token") {
      return sealProbe({
        ...base,
        status: "invalid",
        mcpProbe: rejected,
        refresh: { status: "no_refresh_token", response: null },
      });
    }
    if (refresh.type === "connect_error") {
      return sealProbe({
        ...base,
        mcpProbe: rejected,
        refresh: { status: "connect_error", response: null },
      });
    }
    if (refresh.type === "failed") {
      return sealProbe({
        ...base,
        status: refresh.terminal ? "invalid" : "indeterminate",
        mcpProbe: rejected,
        refresh: { status: "failed", response: refresh.observation },
      });
    }

    const again = await this.exchange(
      parsedMcp,
      INITIALIZE_BODY,
      mcpHeaders(refresh.rotation.accessToken),
    );
    if (again === null) {
      return sealProbe({
        ...base,
        status: "indeterminate",
        mcpProbe: { method: INITIALIZE_METHOD, response: null },
        refresh: { status: "succeeded", response: null },
        rotation: refresh.rotation,
      });
    }
    const againOutcome = classifyMcp(again.statusCode);
    if (againOutcome === "accepted") {
      return sealProbe({
        ...base,
        status: "valid",
        refresh: { status: "succeeded", response: null },
        rotation: refresh.rotation,
      });
    }
    return sealProbe({
      ...base,
      status: againOutcome === "rejected" ? "invalid" : "indeterminate",
      mcpProbe: {
        method: INITIALIZE_METHOD,
        response: observationOf(again, secrets),
      },
      refresh: { status: "succeeded", response: null },
      rotation: refresh.rotation,
    });
  }

  private async refresh(
    auth: CredentialAuth,
    secrets: string[],
  ): Promise<
    | { type: "no_refresh_token" }
    | { type: "connect_error" }
    | {
        type: "failed";
        terminal: boolean;
        observation: CredentialResponseObservation;
      }
    | { type: "succeeded"; rotation: CredentialValidationRotation }
  > {
    if (auth.type !== "mcp_oauth" || auth.refresh == null) {
      return { type: "no_refresh_token" };
    }
    const refreshToken = nonEmpty(auth.refresh.refreshToken);
    if (refreshToken === null) return { type: "no_refresh_token" };
    const endpoint = parseHttpUrl(auth.refresh.tokenEndpoint);
    if (endpoint === null) return { type: "connect_error" };

    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    });
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", refreshToken);
    if (auth.refresh.clientId.length > 0) body.set("client_id", auth.refresh.clientId);
    if (nonEmpty(auth.refresh.resource ?? null) !== null) {
      body.set("resource", auth.refresh.resource ?? "");
    }
    if (nonEmpty(auth.refresh.scope ?? null) !== null) {
      body.set("scope", auth.refresh.scope ?? "");
    }
    const clientSecret =
      auth.refresh.tokenEndpointAuth.type === "none"
        ? null
        : nonEmpty(auth.refresh.tokenEndpointAuth.clientSecret);
    if (
      auth.refresh.tokenEndpointAuth.type === "client_secret_post" &&
      clientSecret !== null
    ) {
      body.set("client_secret", clientSecret);
    }
    if (
      auth.refresh.tokenEndpointAuth.type === "client_secret_basic" &&
      clientSecret !== null
    ) {
      const encoded = encodeBasic(auth.refresh.clientId, clientSecret);
      headers.set("authorization", `Basic ${encoded}`);
      rememberSecret(secrets, encoded);
      rememberSecret(secrets, `Basic ${encoded}`);
    }

    const exchanged = await this.exchange(endpoint, body.toString(), headers);
    if (exchanged === null) return { type: "connect_error" };
    const issued = parseTokenBody(exchanged.rawBody);
    if (issued !== null) {
      rememberSecret(secrets, issued.accessToken);
      rememberSecret(secrets, issued.refreshToken);
      rememberSecret(secrets, issued.idToken);
    }
    const verdict = classifyRefresh(exchanged.statusCode, issued);
    if (verdict === "succeeded" && issued?.accessToken) {
      return {
        type: "succeeded",
        rotation: {
          accessToken: issued.accessToken,
          refreshToken: issued.refreshToken,
          expiresAt: expiresAtFrom(this.clock.now(), issued.expiresIn),
        },
      };
    }
    return {
      type: "failed",
      terminal: verdict === "rejected",
      observation: observationOf(exchanged, secrets),
    };
  }

  private async exchange(
    url: URL,
    body: string,
    headers: Headers,
  ): Promise<Exchange | null> {
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const raw = await readRaw(response, MAX_READ_BYTES);
      return {
        statusCode: response.status,
        contentType: response.headers.get("content-type") ?? "",
        rawBody: raw.text,
        truncated: raw.truncated,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Placeholder kept for tests and explicit non-network composition. Production
 * Node and Cloudflare roots use {@link McpOAuthCredentialValidationProbe}.
 */
export class IndeterminateCredentialValidationProbe
  implements CredentialValidationProbePort
{
  async validate(
    input: ProbeCredentialValidation,
  ): Promise<CredentialValidationProbe> {
    const auth = input.credential.auth;
    rejectCapCli(auth);
    return {
      hasRefreshToken:
        auth.type === "mcp_oauth" &&
        auth.refresh !== undefined &&
        auth.refresh !== null &&
        auth.refresh.refreshToken !== null,
      mcpProbe: null,
      refresh: null,
      status: "indeterminate",
    };
  }
}

function sealProbe(
  probe: Omit<CredentialValidationProbe, "rotation"> & {
    rotation?: CredentialValidationRotation | null;
  },
): CredentialValidationProbe {
  const rotation = probe.rotation ?? null;
  const sealed: CredentialValidationProbe = {
    hasRefreshToken: probe.hasRefreshToken,
    mcpProbe: probe.mcpProbe,
    refresh: probe.refresh,
    status: probe.status,
  };
  Object.defineProperty(sealed, "rotation", {
    configurable: false,
    enumerable: false,
    value: rotation,
    writable: false,
  });
  return sealed;
}

/**
 * `cap_cli` (OpenMA extension) is a CLI credential, not an MCP one: there is
 * no MCP endpoint to probe. The application refuses it before calling a
 * probe; reaching a probe with one is a programming error.
 */
function rejectCapCli(auth: CredentialAuth): void {
  if (auth.type === "cap_cli") {
    throw new TypeError("cap_cli credentials cannot be MCP-validated");
  }
}

function hasRefreshToken(auth: CredentialAuth): boolean {
  return (
    auth.type === "mcp_oauth" &&
    auth.refresh != null &&
    nonEmpty(auth.refresh.refreshToken) !== null
  );
}

function mcpEndpoint(auth: CredentialAuth): string | null {
  if (auth.type === "mcp_oauth" || auth.type === "static_bearer") {
    return auth.mcpServerUrl;
  }
  return null;
}

function bearerToken(auth: CredentialAuth): string | null {
  if (auth.type === "mcp_oauth") return nonEmpty(auth.accessToken);
  if (auth.type === "static_bearer") return nonEmpty(auth.token);
  return null;
}

function collectSecrets(auth: CredentialAuth, secrets: string[]): void {
  if (auth.type === "mcp_oauth") {
    rememberSecret(secrets, auth.accessToken);
    rememberSecret(secrets, auth.refresh?.refreshToken ?? null);
    if (auth.refresh != null && auth.refresh.tokenEndpointAuth.type !== "none") {
      rememberSecret(secrets, auth.refresh.tokenEndpointAuth.clientSecret);
    }
    return;
  }
  if (auth.type === "static_bearer") {
    rememberSecret(secrets, auth.token);
    return;
  }
  if (auth.type === "cap_cli") {
    rememberSecret(secrets, auth.token);
    rememberSecret(secrets, auth.refreshToken ?? null);
    return;
  }
  rememberSecret(secrets, auth.secretValue);
}

function rememberSecret(secrets: string[], value: string | null): void {
  if (value === null || value.length < 8) return;
  secrets.push(value);
  const encoded = encodeURIComponent(value);
  if (encoded !== value) secrets.push(encoded);
}

function mcpHeaders(bearer: string | null): Headers {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
  return headers;
}

function parseHttpUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.hostname.length === 0) return null;
  return url;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function classifyMcp(status: number): McpOutcome {
  if (status >= 200 && status < 300) return "accepted";
  if (status === 401 || status === 403) return "rejected";
  if (status === 429 || status >= 500) return "transient";
  return "unclear";
}

function classifyRefresh(
  status: number,
  issued: ParsedToken | null,
): "succeeded" | "rejected" | "transient" | "unclear" {
  if (
    status >= 200 &&
    status < 300 &&
    issued?.accessToken &&
    issued.oauthError === null
  ) {
    return "succeeded";
  }
  if (status === 429 || status >= 500) return "transient";
  if (
    issued?.oauthError === "temporarily_unavailable" ||
    issued?.oauthError === "server_error"
  ) {
    return "transient";
  }
  if ((status >= 400 && status < 500) || issued?.oauthError != null) {
    return "rejected";
  }
  return "unclear";
}

function parseTokenBody(raw: string): ParsedToken | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    return {
      accessToken: typeof record.access_token === "string"
        ? nonEmpty(record.access_token)
        : null,
      refreshToken: typeof record.refresh_token === "string"
        ? nonEmpty(record.refresh_token)
        : null,
      idToken: typeof record.id_token === "string" ? nonEmpty(record.id_token) : null,
      expiresIn:
        typeof record.expires_in === "number" && Number.isFinite(record.expires_in)
          ? record.expires_in
          : null,
      oauthError:
        typeof record.error === "string" && record.error.length > 0
          ? record.error
          : null,
    };
  } catch {
    return null;
  }
}

function expiresAtFrom(now: Date, expiresIn: number | null): string | null {
  if (expiresIn === null || expiresIn < 0 || expiresIn > TEN_YEARS_SECONDS) {
    return null;
  }
  return new Date(now.getTime() + expiresIn * 1000).toISOString();
}

function observationOf(
  exchange: Exchange,
  secrets: readonly string[],
): CredentialResponseObservation {
  const scrubbed = scrubSecrets(exchange.rawBody, secrets);
  const body =
    scrubbed.length > MAX_OBSERVATION_CHARS
      ? scrubbed.slice(0, MAX_OBSERVATION_CHARS)
      : scrubbed;
  return {
    body,
    bodyTruncated: exchange.truncated || scrubbed.length > body.length,
    contentType: scrubSecrets(exchange.contentType, secrets),
    statusCode: exchange.statusCode,
  };
}

function scrubSecrets(value: string, secrets: readonly string[]): string {
  const unique = [...new Set(secrets.filter((secret) => secret.length >= 8))].sort(
    (left, right) => right.length - left.length,
  );
  let next = value;
  for (const secret of unique) next = next.split(secret).join(REDACTED);
  next = scrubPartialSuffix(next, unique);
  next = next.replace(
    /"(access_token|refresh_token|id_token|client_secret|password|authorization|token)"(\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    `"$1"$2"${REDACTED}"`,
  );
  next = next.replace(
    /(^|[&\s])(access_token|refresh_token|id_token|client_secret|password|token)=([^&\s]*)/gi,
    `$1$2=${REDACTED}`,
  );
  next = next.replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`);
  next = next.replace(/Basic\s+[A-Za-z0-9+/=]+/g, `Basic ${REDACTED}`);
  return next;
}

function scrubPartialSuffix(value: string, secrets: readonly string[]): string {
  let next = value;
  for (const secret of secrets) {
    const max = Math.min(secret.length - 1, next.length);
    for (let length = max; length >= 4; length -= 1) {
      if (next.endsWith(secret.slice(0, length))) {
        next = `${next.slice(0, -length)}${REDACTED}`;
        break;
      }
    }
  }
  return next;
}

async function readRaw(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const value = next.value;
      if (value === undefined || value.byteLength === 0) continue;
      if (size + value.byteLength > maxBytes) {
        const slice = value.subarray(0, maxBytes - size);
        chunks.push(slice);
        size += slice.byteLength;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
    truncated = true;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Drop the unread tail without copying its error text.
    }
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
}

function encodeBasic(clientId: string, clientSecret: string): string {
  const raw = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
