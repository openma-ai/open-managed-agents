import { projectHostedInferenceForAcpAgent } from "@open-managed-agents/acp-runtime/inference-config";
import type { InferenceTargetDescriptor } from "@open-managed-agents/acp-runtime/inference-config";
import type { AcpStatefulAgentSpec } from "@open-managed-agents/acp-runtime/native-state";

import { buildInferenceTarget, type HostedInferenceModelSource } from "./model-source.js";
import { createDefaultHarnessInferenceAdapterRegistry } from "./registry.js";

const defaultRegistry = createDefaultHarnessInferenceAdapterRegistry();

export interface WireHostedInferenceInput {
  sessionId: string;
  gatewayBaseUrl?: string;
  sessionsToken?: string;
  env: Record<string, string | undefined>;
  agent: AcpStatefulAgentSpec;
  nativePath: string;
  model: HostedInferenceModelSource;
  enableProxy?: boolean;
}

export function wireHostedInferenceForAcpLaunch(input: WireHostedInferenceInput) {
  const target: InferenceTargetDescriptor = buildInferenceTarget(input.model);
  return projectHostedInferenceForAcpAgent({
    sessionId: input.sessionId,
    gatewayBaseUrl: input.gatewayBaseUrl,
    sessionsToken: input.sessionsToken,
    env: input.env,
    agent: input.agent,
    nativePath: input.nativePath,
    target,
    adapterRegistry: defaultRegistry,
    enableProxy: input.enableProxy,
  });
}
