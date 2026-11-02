import type { InferenceProtocolEndpoint, InferenceWireProtocol } from "./protocol-types.js";

export interface ParsedHostedInferenceSubPath {
  protocol: InferenceWireProtocol | null;
  relativeSubPath: string;
}

const PROTOCOL_PREFIXES: Array<{ protocol: InferenceWireProtocol; prefix: string }> = [
  { protocol: "openai-chat", prefix: "openai/v1/" },
  { protocol: "openai-responses", prefix: "openai/v1/" },
  { protocol: "anthropic-messages", prefix: "anthropic/" },
  { protocol: "gemini", prefix: "gemini/" },
];

export function parseHostedInferenceSubPath(subPath: string): ParsedHostedInferenceSubPath {
  const normalized = subPath.replace(/^\//, "");
  for (const candidate of PROTOCOL_PREFIXES) {
    if (normalized === candidate.prefix.slice(0, -1)) {
      return { protocol: candidate.protocol, relativeSubPath: "" };
    }
    if (normalized.startsWith(candidate.prefix)) {
      return {
        protocol: candidate.protocol,
        relativeSubPath: normalized.slice(candidate.prefix.length),
      };
    }
  }
  return { protocol: null, relativeSubPath: normalized };
}

export function selectProtocolEndpoint(
  endpoints: readonly InferenceProtocolEndpoint[],
  protocol: InferenceWireProtocol,
): InferenceProtocolEndpoint | null {
  return endpoints.find((endpoint) => endpoint.protocol === protocol) ?? null;
}

export function resolveProtocolUpstreamUrl(
  endpoint: InferenceProtocolEndpoint,
  relativeSubPath: string,
): string {
  const base = endpoint.upstreamBaseUrl.replace(/\/$/, "");
  const relative = relativeSubPath.replace(/^\//, "");
  if (!relative) return base;
  if (endpoint.protocol === "openai-chat" || endpoint.protocol === "openai-responses") {
    let path = relative;
    if (!base.endsWith("/v1") && path.length > 0 && !path.startsWith("v1/")) {
      path = `v1/${path}`;
    }
    while (base.endsWith("/v1") && path.startsWith("v1/")) {
      path = path.slice("v1/".length);
    }
    return path.length === 0 ? base : `${base}/${path}`;
  }
  return `${base}/${relative}`;
}
