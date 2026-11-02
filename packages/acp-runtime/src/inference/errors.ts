import type { InferenceWireProtocol } from "./types.js";

export class InferenceProtocolUnsupportedError extends Error {
  readonly code = "inference_protocol_unsupported";

  constructor(input: {
    adapterId: string;
    supported: readonly InferenceWireProtocol[];
    available: readonly InferenceWireProtocol[];
  }) {
    const supported = input.supported.join(", ");
    const available = input.available.length > 0
      ? input.available.join(", ")
      : "(none)";
    super(
      `Harness adapter "${input.adapterId}" requires [${supported}] but the model target exposes [${available}]`,
    );
    this.name = "InferenceProtocolUnsupportedError";
  }
}

export class InferenceEndpointsMissingError extends Error {
  readonly code = "inference_endpoints_missing";

  constructor(message = "Hosted inference requires explicit protocol endpoints on the model card") {
    super(message);
    this.name = "InferenceEndpointsMissingError";
  }
}
