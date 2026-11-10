import type { ManagedAcpExecutionChannelsRequest, ManagedAcpExecutionChannelsResult } from "@open-managed-agents/shared/acp-execution-channels-rpc";

/** Outbound caller for the existing control-plane authority. Never retries,
 * mints a token, or exposes response bodies/dependency errors on the Work wire. */
export function createExecutionChannelsHttpResolver(options: {
  apiBaseUrl: string;
  fetch?: typeof globalThis.fetch;
}) {
  let base: URL;
  try { base = new URL(options.apiBaseUrl); }
  catch { throw new TypeError("Invalid control-plane API URL"); }
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) {
    throw new TypeError("Invalid control-plane API URL");
  }
  return async (input: ManagedAcpExecutionChannelsRequest): Promise<ManagedAcpExecutionChannelsResult> => {
    if (!input.sessionsToken.startsWith("oma_sbx_")) {
      throw new Error("Execution channels require the current sandbox token; Work bearer is not accepted");
    }
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(
        new URL("/v1/oma/sessions/" + encodeURIComponent(input.sessionId) + "/execution-channels", base),
        { method: "POST", redirect: "error", headers: { authorization: "Bearer " + input.sessionsToken, "content-type": "application/json" }, body: "{}" },
      );
    } catch { throw new Error("Execution channels transport unavailable"); }
    let result: ManagedAcpExecutionChannelsResult;
    try { result = await response.json() as ManagedAcpExecutionChannelsResult; }
    catch { throw new Error(response.ok ? "Execution channels response is not valid JSON" : "Execution channels HTTP " + response.status); }
    if (result?.type === "failed") {
      const phases = ["validation", "configuration", "session_lookup", "model_lookup", "token_validation"];
      const codes = ["invalid_request", "missing_configuration", "session_not_found", "archived", "model_unavailable", "token_rejected", "unavailable"];
      if (phases.includes(result.phase) && codes.includes(result.code) &&
          (response.ok || response.status === 409 && result.phase === "model_lookup" && result.code === "model_unavailable")) {
        return { type: "failed", phase: result.phase, code: result.code, message: "Execution channels authority rejected the request" };
      }
    }
    if (!response.ok) throw new Error("Execution channels HTTP " + response.status);
    if (result?.type === "ready") {
      const { mcpProxy, hostedInference } = result.channels ?? {};
      if (mcpProxy?.sessionsToken === input.sessionsToken && hostedInference?.sessionsToken === input.sessionsToken
        && typeof mcpProxy.gatewayBaseUrl === "string" && typeof hostedInference.gatewayBaseUrl === "string" && hostedInference.model) return result;
    }
    throw new Error("Execution channels response is invalid");
  };
}
