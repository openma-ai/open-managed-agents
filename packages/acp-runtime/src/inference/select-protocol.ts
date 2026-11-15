import { InferenceProtocolUnsupportedError } from "./errors.js";
import type {
  InferenceConfigAdapter,
  InferenceProtocolEndpoint,
  InferenceWireProtocol,
} from "./types.js";

/** Prefer Messages in the real intersection, then adapter preference order. */
export function selectInferenceProtocol(
  adapter: InferenceConfigAdapter,
  endpoints: readonly InferenceProtocolEndpoint[],
): { protocol: InferenceWireProtocol; endpoint: InferenceProtocolEndpoint } {
  const byProtocol = new Map(
    endpoints.map((endpoint) => [endpoint.protocol, endpoint]),
  );
  const messages = byProtocol.get("anthropic-messages");
  if (messages && adapter.supportedProtocols.includes("anthropic-messages")) {
    return { protocol: "anthropic-messages", endpoint: messages };
  }
  for (const protocol of adapter.supportedProtocols) {
    const endpoint = byProtocol.get(protocol);
    if (endpoint) {
      return { protocol, endpoint };
    }
  }
  throw new InferenceProtocolUnsupportedError({
    adapterId: adapter.id,
    supported: adapter.supportedProtocols,
    available: endpoints.map((item) => item.protocol),
  });
}
