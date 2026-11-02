import {
  MODEL_PROVIDER_SECRET_ENV_KEYS,
  projectHostedInferenceEnv,
} from "@open-managed-agents/inference-proxy";

import { InferenceEndpointsMissingError } from "./errors.js";
import { selectInferenceProtocol } from "./select-protocol.js";
import type { InferenceConfigAdapterRegistry } from "./registry.js";
import type {
  HostedInferenceProxyTarget,
  InferenceConfigFile,
  InferenceTargetDescriptor,
} from "./types.js";

const EXTRA_STRIP_ENV_KEYS = ["OPENAI_BASE_URL"] as const;

export interface ProjectHostedInferenceInput {
  sessionId: string;
  gatewayBaseUrl?: string;
  sessionsToken?: string;
  env: Record<string, string | undefined>;
  agent: import("../native-state.js").AcpStatefulAgentSpec;
  nativePath: string;
  target: InferenceTargetDescriptor;
  adapterRegistry: InferenceConfigAdapterRegistry;
  enableProxy?: boolean;
}

export interface ProjectHostedInferenceResult {
  env: Record<string, string | undefined>;
  files: readonly InferenceConfigFile[];
}

function stripProviderSecrets(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const next = { ...env };
  for (const key of MODEL_PROVIDER_SECRET_ENV_KEYS) {
    next[key] = undefined;
  }
  for (const key of EXTRA_STRIP_ENV_KEYS) {
    next[key] = undefined;
  }
  return next;
}

export function projectHostedInferenceForAcpAgent(
  input: ProjectHostedInferenceInput,
): ProjectHostedInferenceResult {
  const enable = input.enableProxy !== false
    && input.sessionId.length > 0
    && Boolean(input.sessionsToken)
    && Boolean(input.gatewayBaseUrl);

  if (!enable) {
    return { env: { ...input.env }, files: [] };
  }

  const capability = {
    gatewayBaseUrl: input.gatewayBaseUrl!,
    sessionsToken: input.sessionsToken!,
  };
  const hostedEnv = projectHostedInferenceEnv(input.sessionId, capability);
  const proxy: HostedInferenceProxyTarget = {
    proxyBaseUrl: hostedEnv.HOSTED_INFERENCE_URL,
    proxyToken: hostedEnv.HOSTED_INFERENCE_TOKEN,
    proxyTokenEnvVar: "HOSTED_INFERENCE_TOKEN",
  };

  const adapter = input.adapterRegistry.findForAgent(input.agent);
  let env = stripProviderSecrets(input.env);

  if (!adapter) {
    return { env, files: [] };
  }

  if (input.target.protocolEndpoints.length === 0) {
    throw new InferenceEndpointsMissingError();
  }

  const { protocol, endpoint } = selectInferenceProtocol(
    adapter,
    input.target.protocolEndpoints,
  );
  const plan = adapter.plan({
    agent: input.agent,
    nativePath: input.nativePath,
    target: input.target,
    proxy,
    protocol,
    endpoint,
  });

  env = {
    ...env,
    ...hostedEnv,
    ...plan.env,
  };
  for (const key of plan.unsetEnv) {
    // Preserve explicit unsets so spawners cannot inherit provider credentials.
    env[key] = undefined;
  }

  return { env, files: plan.files };
}
