// The sandbox token on API requests (model gateway, MCP gateway, sandbox API):
// where it is carried and which Session it names. The bearer (or x-api-key)
// is the token alone; the Session id is the proxy path's, or the Basic
// username on the sandbox API. `absent` = not a sandbox token, the caller's
// other credentials apply.

import { isSandboxTokenShaped, parseSandboxBasicCredential, sandboxTokenRandomPart } from "./sandbox-token";
import { authenticateSandboxToken, type SandboxTokenResolution } from "./sandbox-token-authority";
import { proxySessionId, sandboxTokenAllows } from "./sandbox-token-routes";
import type { SandboxTokenStore } from "./sandbox-token-store";

export type SandboxTokenTransport = "bearer" | "x-api-key" | "basic";

export type SandboxRequestDecision =
  | { type: "absent" }
  | { type: "accepted"; resolution: SandboxTokenResolution; transport: SandboxTokenTransport }
  | { type: "rejected" }
  | { type: "unavailable"; error: unknown };

export interface SandboxTokenRequest {
  method: string;
  path: string;
  authorization: string | null;
  apiKey: string | null;
}

interface Presented { token: string; basicSessionId: string | null; transport: SandboxTokenTransport }

function presented(request: SandboxTokenRequest): Presented | "malformed" | null {
  const authorization = request.authorization ?? "";
  if (/^Basic\s/iu.test(authorization)) {
    const basic = parseSandboxBasicCredential(authorization);
    if (basic === null) return null;
    return isSandboxTokenShaped(basic.token) ? { token: basic.token, basicSessionId: basic.sessionId, transport: "basic" } : null;
  }
  const bearer = /^Bearer (\S+)$/u.exec(authorization)?.[1] ?? null;
  const apiKey = request.apiKey;
  const bearerToken = bearer !== null && isSandboxTokenShaped(bearer);
  const apiKeyToken = apiKey !== null && isSandboxTokenShaped(apiKey);
  // Two different credentials on one request: refuse rather than pick one.
  if ((bearerToken || apiKeyToken) && bearer !== null && apiKey !== null && bearer !== apiKey) return "malformed";
  if (bearerToken) return { token: bearer!, basicSessionId: null, transport: "bearer" };
  if (apiKeyToken) return { token: apiKey!, basicSessionId: null, transport: "x-api-key" };
  return null;
}

export async function authenticateSandboxTokenRequest(
  store: SandboxTokenStore | null,
  request: SandboxTokenRequest,
  now: () => number = Date.now,
): Promise<SandboxRequestDecision> {
  const credential = presented(request);
  if (credential === null) return { type: "absent" };
  if (credential === "malformed" || sandboxTokenRandomPart(credential.token) === null) return { type: "rejected" };
  const pathSessionId = proxySessionId(request.path);
  // A proxy path names the Session; elsewhere only the Basic username can.
  const sessionId = pathSessionId ?? credential.basicSessionId;
  if (sessionId === null || (credential.basicSessionId !== null && credential.basicSessionId !== sessionId)) return { type: "rejected" };
  if (store === null) return { type: "unavailable", error: new Error("Sandbox token store is not configured") };
  // Model gateway, MCP gateway and sandbox API: `all` only.
  const decision = await authenticateSandboxToken(store, { sessionId, token: credential.token, channel: "api" }, now);
  if (decision.type !== "accepted") return decision;
  return sandboxTokenAllows(decision.session, request.method, request.path)
    ? { type: "accepted", resolution: decision.resolution, transport: credential.transport }
    : { type: "rejected" };
}

/** The platforms' auth middleware shape (@open-managed-agents/auth
 * SandboxTokenAuthDecision): the accepted token acts as the Session's
 * `environment_work_session` credential (tenant = the Session's workspace). */
export async function sandboxTokenAuthDecision(
  store: SandboxTokenStore | null,
  request: { headers: Headers; method: string; path: string },
  now: () => number = Date.now,
) {
  const decision = await authenticateSandboxTokenRequest(store, {
    method: request.method, path: request.path,
    authorization: request.headers.get("authorization"), apiKey: request.headers.get("x-api-key"),
  }, now);
  if (decision.type !== "accepted") return decision;
  const r = decision.resolution;
  return {
    type: "accepted" as const,
    transport: decision.transport,
    resolution: {
      tenantId: r.workspaceId,
      credential: {
        type: "environment_work_session" as const,
        environmentId: r.environmentId, sessionId: r.sessionId, workId: r.workId, claimedAt: r.claimedAt, generation: r.generation,
      },
    },
  };
}
