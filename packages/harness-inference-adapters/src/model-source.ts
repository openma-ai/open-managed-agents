import {
  InferenceEndpointsMissingError,
  type InferenceTargetDescriptor,
} from "@open-managed-agents/acp-runtime/inference-config";

import {
  resolveProtocolEndpointsFromModelCard,
  type ModelCardInferenceFields,
} from "./endpoint-catalog.js";

export interface HostedInferenceModelSource extends ModelCardInferenceFields {
  wireModel: string;
}

export function buildInferenceTarget(
  source: HostedInferenceModelSource,
): InferenceTargetDescriptor {
  const protocolEndpoints = resolveProtocolEndpointsFromModelCard(source);
  if (protocolEndpoints.length === 0) {
    throw new InferenceEndpointsMissingError(
      `No protocol endpoints for provider "${source.providerId}"`,
    );
  }
  return {
    wireModel: source.wireModel,
    providerId: source.providerId,
    protocolEndpoints,
  };
}
