import type { AcpStatefulAgentSpec } from "../native-state.js";

/** Closed set of wire protocols supported by hosted inference routing. */
export type InferenceWireProtocol =
  | "anthropic-messages"
  | "openai-chat"
  | "openai-responses"
  | "gemini";

/** Sandbox-relative path suffix on the session hosted-inference base URL. */
export const INFERENCE_PROTOCOL_PROXY_PATH: Record<InferenceWireProtocol, string> = {
  "openai-chat": "openai/v1",
  "openai-responses": "openai/v1",
  "anthropic-messages": "anthropic",
  gemini: "gemini",
};

export interface InferenceProtocolEndpoint {
  protocol: InferenceWireProtocol;
  proxyPathSegment: string;
  /** Provider upstream API root for this protocol (no trailing slash). */
  upstreamBaseUrl: string;
}

/** Resolved model target — endpoints must be supplied by the composition root. */
export interface InferenceTargetDescriptor {
  wireModel: string;
  /** Model-card provider id (opaque string for harness adapters). */
  providerId: string;
  protocolEndpoints: readonly InferenceProtocolEndpoint[];
}

export interface HostedInferenceProxyTarget {
  proxyBaseUrl: string;
  proxyToken: string;
  proxyTokenEnvVar: "HOSTED_INFERENCE_TOKEN";
}

export interface InferenceConfigFile {
  path: string;
  content: string;
}

export interface InferenceConfigPlan {
  protocol: InferenceWireProtocol;
  env: Record<string, string>;
  unsetEnv: readonly string[];
  args?: readonly string[];
  files: readonly InferenceConfigFile[];
}

export interface InferenceConfigPlanContext {
  agent: AcpStatefulAgentSpec;
  nativePath: string;
  target: InferenceTargetDescriptor;
  proxy: HostedInferenceProxyTarget;
  protocol: InferenceWireProtocol;
  endpoint: InferenceProtocolEndpoint;
}

export interface InferenceConfigAdapter {
  readonly id: string;
  matches(agent: AcpStatefulAgentSpec): boolean;
  readonly supportedProtocols: readonly InferenceWireProtocol[];
  plan(context: InferenceConfigPlanContext): InferenceConfigPlan;
}
