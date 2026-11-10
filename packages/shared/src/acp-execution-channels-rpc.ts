/** Wire contract for MAIN_MCP.managedAcpExecutionChannels on the existing
 * sandbox-token authority. Typed mode returns expected failures as values;
 * callers throw locally, never downgrade to empty or legacy channels. */
export interface ManagedAcpExecutionChannelsRequest {
  tenantId: string;
  sessionId: string;
  sessionsToken: string;
}

export interface ManagedAcpExecutionChannels {
  mcpProxy: { gatewayBaseUrl: string; sessionsToken: string };
  hostedInference: {
    gatewayBaseUrl: string;
    sessionsToken: string;
    model: {
      providerId: string;
      baseUrl: string | null;
      /** The card's upstream model id, not its handle. */
      wireModel?: string;
      protocolEndpoints?: readonly {
        protocol: "anthropic-messages" | "openai-chat" | "openai-responses" | "gemini";
        proxyPathSegment: string;
        upstreamBaseUrl: string;
      }[];
    };
  };
}

export type ManagedAcpExecutionChannelsResult =
  | { type: "ready"; channels: ManagedAcpExecutionChannels }
  | { type: "failed";
      phase: "validation" | "configuration" | "session_lookup" | "model_lookup" | "token_validation";
      code: "invalid_request" | "missing_configuration" | "session_not_found" | "archived" | "model_unavailable" | "token_rejected" | "unavailable";
      /** Safe actionable diagnostic only: no token/hash, config body, provider
       * secret, raw dependency error text or stack. A store read failure remains
       * unavailable, not token_rejected (and never legacy_without_token). */
      message: string;
      cause?: { name: string; code?: string } };
