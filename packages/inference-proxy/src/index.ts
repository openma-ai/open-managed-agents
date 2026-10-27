import type { InferenceProtocolEndpoint, InferenceWireProtocol } from "./protocol-types.js";
import {
  parseHostedInferenceSubPath,
  resolveProtocolUpstreamUrl,
  selectProtocolEndpoint,
} from "./protocol-routing.js";

/** Env vars that must not reach an ACP child when hosted inference proxying is on. */
export const MODEL_PROVIDER_SECRET_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

/** Inbound headers that carry caller or provider credentials — never forwarded upstream. */
export const INBOUND_CREDENTIAL_HEADER_NAMES = [
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "proxy-authorization",
] as const;

export interface HostedInferenceCapability {
  gatewayBaseUrl: string;
  sessionsToken: string;
}

export type { InferenceProtocolEndpoint, InferenceWireProtocol } from "./protocol-types.js";
export {
  resolveProtocolEndpointsFromModelCard,
  type ModelCardInferenceFields,
} from "./endpoint-catalog.js";
export {
  parseHostedInferenceSubPath,
  resolveProtocolUpstreamUrl,
  selectProtocolEndpoint,
} from "./protocol-routing.js";

export interface ResolvedSessionModelUpstream {
  wireModel: string;
  apiKey: string;
  baseURL?: string;
  provider?: string;
  providerId?: string;
  protocolEndpoints?: readonly InferenceProtocolEndpoint[];
  customHeaders?: Record<string, string>;
}

export interface StoredModelCardProviderConfig {
  model: string;
  provider: string;
  base_url: string | null;
  custom_headers: Record<string, string> | null;
}

export function bindStoredModelCardCredentials(
  fallback: ResolvedSessionModelUpstream,
  card: StoredModelCardProviderConfig,
  apiKey: string,
): ResolvedSessionModelUpstream {
  return {
    wireModel: card.model,
    apiKey,
    baseURL: card.base_url ?? undefined,
    provider: card.provider,
    customHeaders: card.custom_headers ?? undefined,
  };
}

const DEFAULT_PROVIDER_BASES: Record<string, string> = {
  deepseek: "https://api.deepseek.com",
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
};

/** OpenMA gateway base for Harbor-style hosted inference (no trailing slash). */
export function buildHostedInferenceBaseUrl(
  gatewayBaseUrl: string,
  sessionId: string,
): string {
  const gateway = new URL(gatewayBaseUrl);
  gateway.username = "";
  gateway.password = "";
  gateway.search = "";
  gateway.hash = "";
  gateway.pathname = [
    "v1",
    "oma",
    "inference-proxy",
    encodeURIComponent(sessionId),
  ].join("/");
  return gateway.toString().replace(/\/$/, "");
}

export function projectHostedInferenceEnv(
  sessionId: string,
  capability: HostedInferenceCapability,
): {
  HOSTED_INFERENCE_URL: string;
  HOSTED_INFERENCE_TOKEN: string;
} {
  return {
    HOSTED_INFERENCE_URL: buildHostedInferenceBaseUrl(
      capability.gatewayBaseUrl,
      sessionId,
    ),
    HOSTED_INFERENCE_TOKEN: capability.sessionsToken,
  };
}

/** Strip provider API keys and apply hosted inference env when proxying is enabled. */
export function applyHostedInferenceToAgentEnv(input: {
  sessionId: string;
  env: Record<string, string | undefined>;
  capability: HostedInferenceCapability | null;
  enableProxy?: boolean;
}): Record<string, string | undefined> {
  const enable = input.enableProxy !== false && input.capability !== null;
  const next = { ...input.env };
  if (!enable) return next;
  for (const key of MODEL_PROVIDER_SECRET_ENV_KEYS) {
    delete next[key];
  }
  delete next.OPENAI_BASE_URL;
  return {
    ...next,
    ...projectHostedInferenceEnv(input.sessionId, input.capability!),
  };
}

export function isHostedInferenceProxyPath(path: string): boolean {
  return /^\/v1\/oma\/inference-proxy\/[^/]+/u.test(path);
}

function bearerTokenFromAuthorization(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  if (authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    return token.length > 0 ? token : null;
  }
  const trimmed = authorization.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type HostedInferenceProxyTokenResult =
  | { status: "ok"; token: string; transport: "bearer" | "x-api-key" }
  | { status: "missing" }
  | { status: "mismatch" };

/** Parse the session / workspace token presented to the hosted inference proxy. */
export function extractHostedInferenceProxyToken(
  headers: Headers,
): HostedInferenceProxyTokenResult {
  const bearer = bearerTokenFromAuthorization(headers.get("authorization"));
  const apiKey = headers.get("x-api-key")?.trim() || null;
  if (!bearer && !apiKey) return { status: "missing" };
  if (bearer && apiKey && bearer !== apiKey) return { status: "mismatch" };
  const token = bearer ?? apiKey!;
  const transport = bearer ? "bearer" : "x-api-key";
  return { status: "ok", token, transport };
}

/** Join model-card base URL with the OpenAI-compatible subpath from the sandbox client. */
export function resolveUpstreamInferenceUrl(input: {
  subPath: string;
  baseURL?: string;
  provider?: string;
}): string | null {
  const sub = input.subPath.replace(/^\//, "");
  if (!sub || sub.includes("..")) return null;
  const trimmedBase = input.baseURL?.replace(/\/$/, "");
  const root = trimmedBase
    ?? (input.provider ? DEFAULT_PROVIDER_BASES[input.provider] : undefined);
  if (!root) return null;
  let relative = sub;
  while (root.endsWith("/v1") && relative.startsWith("v1/")) {
    relative = relative.slice("v1/".length);
  }
  return `${root}/${relative}`;
}

const INBOUND_CREDENTIAL_HEADERS = new Set(
  INBOUND_CREDENTIAL_HEADER_NAMES.map((name) => name.toLowerCase()),
);

/** The caller's headers minus its credentials and OpenMA routing headers.
 * Hop-by-hop hygiene belongs to the HTTP hop that sends the plan. */
export function copyInboundHeadersForUpstream(inboundHeaders: Headers): Headers {
  const outbound = new Headers();
  for (const [name, value] of inboundHeaders.entries()) {
    const lower = name.toLowerCase();
    if (INBOUND_CREDENTIAL_HEADERS.has(lower) || lower.startsWith("x-oma-")) continue;
    outbound.set(name, value);
  }
  return outbound;
}

function isAnthropicProvider(provider: string | undefined): boolean {
  if (!provider) return false;
  return /^(ant|anthropic|ant-compatible)$/i.test(provider);
}

function isGeminiProvider(provider: string | undefined): boolean {
  if (!provider) return false;
  return /^(gemini|google)$/i.test(provider);
}

/** Apply the upstream provider's expected credential header scheme. */
export function applyUpstreamProviderCredentials(
  headers: Headers,
  upstream: Pick<ResolvedSessionModelUpstream, "apiKey" | "provider">,
): void {
  for (const name of INBOUND_CREDENTIAL_HEADER_NAMES) {
    headers.delete(name);
  }
  if (isAnthropicProvider(upstream.provider)) {
    headers.set("x-api-key", upstream.apiKey);
    headers.delete("authorization");
    return;
  }
  if (isGeminiProvider(upstream.provider)) {
    headers.set("x-goog-api-key", upstream.apiKey);
    headers.delete("authorization");
    return;
  }
  headers.set("authorization", `Bearer ${upstream.apiKey}`);
}

export function applyUpstreamCredentialsForProtocol(
  headers: Headers,
  protocol: InferenceWireProtocol,
  apiKey: string,
): void {
  for (const name of INBOUND_CREDENTIAL_HEADER_NAMES) {
    headers.delete(name);
  }
  if (protocol === "anthropic-messages") {
    headers.set("x-api-key", apiKey);
    headers.delete("authorization");
    return;
  }
  if (protocol === "gemini") {
    headers.set("x-goog-api-key", apiKey);
    headers.delete("authorization");
    return;
  }
  headers.set("authorization", `Bearer ${apiKey}`);
}

export interface HostedInferenceRequestInput {
  upstream: ResolvedSessionModelUpstream;
  method: string;
  subPath: string;
  inboundHeaders: Headers;
  body: ArrayBuffer | null;
}

/** The upstream request a hosted inference call becomes: pinned model,
 * host-resolved credentials, no caller credentials. */
export interface HostedInferencePlan {
  url: string;
  method: string;
  headers: Headers;
  body: string | ArrayBuffer | null;
}

/**
 * Plan an OpenAI/Anthropic/Gemini-compatible inference call using
 * host-resolved credentials. Returns the upstream request to send, or the
 * error `Response` to return to the caller. Sending is the HTTP route
 * layer's job.
 */
export function planHostedInferenceRequest(
  input: HostedInferenceRequestInput,
): HostedInferencePlan | Response {
  const parsed = parseHostedInferenceSubPath(input.subPath);
  const queryIndex = parsed.relativeSubPath.indexOf("?");
  const path = queryIndex < 0 ? parsed.relativeSubPath : parsed.relativeSubPath.slice(0, queryIndex);
  const query = queryIndex < 0 ? "" : parsed.relativeSubPath.slice(queryIndex);
  // This gateway is a pinned-model inference capability, not a provider API
  // tunnel. Batch/files/fine-tuning and other nested-model endpoints are not
  // supported until their complete model semantics can be enforced.
  const gemini = /^(v1(?:beta)?\/models\/)[^/:?#]+:(generateContent|streamGenerateContent|countTokens)$/.exec(path);
  const jsonModelEndpoint = /^(?:v1\/)?(?:messages(?:\/count_tokens)?|chat\/completions|responses)$/.test(path);
  const modelList = /^(?:v1\/)?models$/.test(path) && input.method.toUpperCase() === "GET";
  if (!(input.method.toUpperCase() === "POST" && (gemini || jsonModelEndpoint)) && !modelList) {
    return Response.json({ error: "inference_endpoint_unsupported" }, { status: 400 });
  }
  const protocol: InferenceWireProtocol | null = gemini ? "gemini"
    : /^(?:v1\/)?messages(?:\/count_tokens)?$/.test(path) ? "anthropic-messages"
    : /^(?:v1\/)?chat\/completions$/.test(path) ? "openai-chat"
    : /^(?:v1\/)?responses$/.test(path) ? "openai-responses" : parsed.protocol;
  // OpenAI chat and responses share a prefix; other prefixes must match the
  // endpoint semantics. A legacy unprefixed route is checked the same way.
  if (parsed.protocol && protocol && parsed.protocol !== protocol
    && !(parsed.protocol.startsWith("openai-") && protocol.startsWith("openai-"))) {
    return Response.json({ error: "inference_protocol_unsupported", protocol }, { status: 409 });
  }
  let subPath = input.subPath;
  if (gemini) {
    const wireModel = input.upstream.wireModel.replace(/^models\//, "");
    if (!/^[A-Za-z0-9._-]+$/.test(wireModel)) {
      return Response.json({ error: "inference_model_unsupported" }, { status: 409 });
    }
    parsed.relativeSubPath = `${gemini[1]}${wireModel}:${gemini[2]}${query}`;
    subPath = parsed.protocol === "gemini" ? `gemini/${parsed.relativeSubPath}` : parsed.relativeSubPath;
  }
  let upstreamUrl: string | null = null;
  const outbound = copyInboundHeadersForUpstream(input.inboundHeaders);
  if (protocol && input.upstream.protocolEndpoints !== undefined) {
    const endpoint = selectProtocolEndpoint(input.upstream.protocolEndpoints, protocol);
    if (!endpoint) {
      return Response.json(
        { error: "inference_protocol_unsupported", protocol },
        { status: 409 },
      );
    }
    upstreamUrl = resolveProtocolUpstreamUrl(endpoint, parsed.relativeSubPath);
    applyUpstreamCredentialsForProtocol(outbound, protocol, input.upstream.apiKey);
  } else {
    upstreamUrl = resolveUpstreamInferenceUrl({
      subPath,
      baseURL: input.upstream.baseURL,
      provider: input.upstream.provider,
    });
    applyUpstreamProviderCredentials(outbound, input.upstream);
  }
  if (!upstreamUrl) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (input.upstream.customHeaders) {
    for (const [name, value] of Object.entries(input.upstream.customHeaders)) {
      outbound.set(name, value);
    }
  }
  let body: string | ArrayBuffer | null = null;
  if (input.method.toUpperCase() === "POST") {
    // All supported inference endpoints use JSON. Do not let a caller bypass
    // model pinning by omitting or forging Content-Type.
    try {
      if (input.body === null) throw new Error("missing body");
      const parsedBody: unknown = JSON.parse(new TextDecoder().decode(input.body));
      if (parsedBody === null || typeof parsedBody !== "object" || Array.isArray(parsedBody)) throw new Error("invalid body");
      if (gemini?.[2] === "countTokens") {
        // CountTokensRequest embeds a GenerateContentRequest. Proto JSON
        // accepts both field spellings; pin both rather than only the URL.
        const record = parsedBody as Record<string, unknown>;
        for (const field of ["generateContentRequest", "generate_content_request"]) {
          const nested = record[field];
          if (nested === undefined || nested === null) continue;
          if (typeof nested !== "object" || Array.isArray(nested)) throw new Error("invalid nested request");
          record[field] = { ...nested, model: `models/${input.upstream.wireModel.replace(/^models\//, "")}` };
        }
        body = JSON.stringify(record);
      } else {
        body = jsonModelEndpoint
          ? JSON.stringify({ ...parsedBody, model: input.upstream.wireModel })
          : input.body;
      }
      outbound.set("content-type", "application/json");
    } catch {
      return Response.json({ error: "invalid_inference_body" }, { status: 400 });
    }
  }
  return { url: upstreamUrl, method: input.method, headers: outbound, body };
}
