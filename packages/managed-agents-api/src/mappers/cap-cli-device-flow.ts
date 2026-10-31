import type {
  CapCliDeviceFlowView,
  PollCapCliDeviceFlowResult,
} from "../ports/cap-cli-device-flow";

export function toCapCliDeviceFlowResponse(flow: CapCliDeviceFlowView): object {
  return {
    type: "cap_cli_device_flow",
    cli_id: flow.cliId,
    flow_token: flow.flowToken,
    user_code: flow.userCode,
    verification_uri: flow.verificationUri,
    ...(flow.verificationUriComplete !== undefined && {
      verification_uri_complete: flow.verificationUriComplete,
    }),
    interval_seconds: flow.intervalSeconds,
    expires_at: flow.expiresAt,
  };
}

export function toCapCliDeviceFlowPollResponse(
  result: Exclude<PollCapCliDeviceFlowResult, { type: "not_found" | "invalid_request" }>,
): object {
  switch (result.type) {
    case "pending":
    case "expired":
    case "denied":
      return { status: result.type };
    case "error":
      return {
        status: "error",
        oauth_error: result.oauthError,
        ...(result.description !== undefined && { description: result.description }),
      };
    case "slow_down":
      return {
        status: "slow_down",
        interval_seconds: result.intervalSeconds,
        flow_token: result.flowToken,
      };
    case "ready":
      return { status: "ready", credential_id: result.credentialId };
  }
}
