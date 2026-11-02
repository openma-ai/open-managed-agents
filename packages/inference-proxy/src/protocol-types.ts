export type InferenceWireProtocol =
  | "anthropic-messages"
  | "openai-chat"
  | "openai-responses"
  | "gemini";

export interface InferenceProtocolEndpoint {
  protocol: InferenceWireProtocol;
  proxyPathSegment: string;
  upstreamBaseUrl: string;
}

export const INFERENCE_PROTOCOL_PROXY_PATH: Record<InferenceWireProtocol, string> = {
  "openai-chat": "openai/v1",
  "openai-responses": "openai/v1",
  "anthropic-messages": "anthropic",
  gemini: "gemini",
};
