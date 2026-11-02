import { InferenceProtocolUnsupportedError } from "./errors.js";
import type {
  InferenceConfigAdapter,
  InferenceProtocolEndpoint,
  InferenceWireProtocol,
} from "./types.js";

/** Prefer adapter protocol order over endpoint list order. */
export function selectInferenceProtocol(
  adapter: InferenceConfigAdapter,
  endpoints: readonly InferenceProtocolEndpoint[],
): { protocol: InferenceWireProtocol; endpoint: InferenceProtocolEndpoint } {
  const byProtocol = new Map(
    endpoints.map((endpoint) => [endpoint.protocol, endpoint]),
  );
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
