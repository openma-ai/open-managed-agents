// CapCliDeviceFlowPort backed by the CLI Auth Protocol builtin specs. cap
// builds and parses the RFC 8628 messages; this adapter only performs the
// HTTP exchange through the injected fetch.

import {
  builtinSpecs,
  createSpecRegistry,
  buildDeviceInitiateRequest,
  buildDevicePollRequest,
  parseDeviceInitiateResponse,
  parseDevicePollResponse,
  type HttpReqLike,
  type HttpResLike,
  type SpecRegistry,
} from "@open-managed-agents/cap";
import type {
  CapCliDeviceFlowInitiateResult,
  CapCliDeviceFlowPollResult,
  CapCliDeviceFlowPort,
  CapCliDeviceFlowState,
} from "@open-managed-agents/managed-agents-application";

export interface CapDeviceFlowOptions {
  registry: SpecRegistry;
  fetch: (input: string, init: RequestInit) => Promise<Response>;
  clock?: { nowMs(): number };
}

export class CapDeviceFlow implements CapCliDeviceFlowPort {
  private readonly clock: { nowMs(): number };

  constructor(private readonly options: CapDeviceFlowOptions) {
    this.clock = options.clock ?? { nowMs: () => Date.now() };
  }

  async initiate(cliId: string): Promise<CapCliDeviceFlowInitiateResult> {
    const spec = this.options.registry.byCliId(cliId);
    if (spec === null) return { type: "unknown_cli" };
    if (!spec.oauth?.device_flow) return { type: "no_device_flow" };
    const clientId = spec.oauth.device_flow.client_id;
    if (!clientId.trim() || clientId.startsWith("__cap_")) {
      return {
        type: "upstream_error",
        message: `OAuth device-flow client for ${cliId} is not configured. Register an OAuth client or add a personal access token manually.`,
      };
    }
    try {
      const state = parseDeviceInitiateResponse(
        spec,
        await this.exchange(buildDeviceInitiateRequest(spec)),
        this.clock,
      );
      return {
        type: "started",
        state: {
          deviceCode: state.device_code,
          userCode: state.user_code,
          verificationUri: state.verification_uri,
          ...(state.verification_uri_complete !== undefined && {
            verificationUriComplete: state.verification_uri_complete,
          }),
          intervalSeconds: state.interval_seconds,
          expiresAtMs: state.expires_at_ms,
        },
      };
    } catch (error) {
      return {
        type: "upstream_error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async poll(
    cliId: string,
    state: CapCliDeviceFlowState,
  ): Promise<CapCliDeviceFlowPollResult> {
    const spec = this.options.registry.byCliId(cliId);
    if (spec === null) throw new Error(`Unknown cap_cli cli_id "${cliId}"`);
    const capState = {
      device_code: state.deviceCode,
      user_code: state.userCode,
      verification_uri: state.verificationUri,
      ...(state.verificationUriComplete !== undefined && {
        verification_uri_complete: state.verificationUriComplete,
      }),
      interval_seconds: state.intervalSeconds,
      expires_at_ms: state.expiresAtMs,
    };
    let response: HttpResLike;
    try {
      response = await this.exchange(buildDevicePollRequest(spec, capState));
    } catch (error) {
      return {
        type: "error",
        oauthError: "upstream_unreachable",
        description: error instanceof Error ? error.message : String(error),
      };
    }
    const result = parseDevicePollResponse(spec, response, this.clock, capState);
    switch (result.kind) {
      case "pending":
      case "expired":
      case "denied":
        return { type: result.kind };
      case "slow_down":
        return { type: "slow_down", intervalSeconds: result.new_interval_seconds };
      case "error":
        return {
          type: "error",
          oauthError: result.oauth_error,
          ...(result.description !== undefined && { description: result.description }),
        };
      case "ready": {
        const { refresh_token: refreshToken, ...extras } = result.token.extras ?? {};
        return {
          type: "ready",
          token: {
            token: result.token.token,
            refreshToken: refreshToken ?? null,
            expiresAt:
              result.token.expires_at === undefined
                ? null
                : new Date(result.token.expires_at).toISOString(),
            extras,
          },
        };
      }
    }
  }

  private async exchange(request: HttpReqLike): Promise<HttpResLike> {
    const response = await this.options.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== null && { body: request.body }),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  }
}

/** A device flow over the builtin CLI specs. */
export function createBuiltinCapDeviceFlow(
  options: Omit<CapDeviceFlowOptions, "registry">,
): CapDeviceFlow {
  return new CapDeviceFlow({ ...options, registry: createSpecRegistry(builtinSpecs) });
}
