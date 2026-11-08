import { Hono, type Context, type Env } from "hono";
import { bindAccessLossHooks, mcpRequestBodyText } from "@open-managed-agents/mcp-access-loss";
import { bufferRequestBody, type ReplayableBody } from "./forward";
import { forwardMcpProxyTarget } from "./mcp-proxy-forward";
import type { McpProxyPorts } from "./mcp-proxy-ports";
import { resolveMcpProxyTarget, type McpProxyTargetRequest } from "./mcp-proxy-target";

export interface McpProxyRequest extends McpProxyTargetRequest {
  method: string;
  headers: Headers;
  /** Read only once the target resolves: a refused call is not buffered. */
  body: () => Promise<ReplayableBody>;
  callerKind: "http" | "rpc-mcp";
}

/**
 * The MCP gateway (design §0.7): validate (Session, server) and resolve its
 * credential, then forward with that credential injected. Every refusal is
 * the same 403, so a caller cannot tell a missing Session from an
 * undeclared server or a missing credential.
 */
export async function forwardMcpProxyRequest(
  ports: McpProxyPorts,
  request: McpProxyRequest,
): Promise<Response> {
  const target = await resolveMcpProxyTarget(ports, request);
  if (target === null) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = await request.body();
  const scope = { workspaceId: request.workspaceId, sessionId: request.sessionId, serverName: request.serverName };
  const hooks = ports.accessLoss === undefined
    ? undefined
    : await bindAccessLossHooks(ports.accessLoss, { ...scope, requestBody: mcpRequestBodyText(body) });
  return forwardMcpProxyTarget(ports, {
    workspaceId: request.workspaceId,
    target,
    method: request.method,
    headers: request.headers,
    body,
    audit: { sessionId: request.sessionId, serverName: request.serverName, callerKind: request.callerKind },
    ...(hooks !== undefined && { onFinal: (result) => hooks.onFinal(result) }),
  });
}

/**
 * `/:sessionId/:serverName`, mounted under `/v1/oma/mcp-proxy`. The parent
 * middleware authenticates the caller (workspace API key or the sandbox
 * bearer, through sandbox-gateway) and sets `tenant_id`; the workspace is
 * never taken from the request itself.
 */
export function createMcpProxyRoutes<E extends Env>(
  portsFor: (workspaceId: string, context: Context<E>) => McpProxyPorts | Promise<McpProxyPorts>,
) {
  const routes = new Hono<E>();
  routes.all("/:sessionId/:serverName", async (context) => {
    const workspaceId = (context.var as { tenant_id?: string }).tenant_id;
    if (!workspaceId) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const request = context.req.raw;
    return forwardMcpProxyRequest(await portsFor(workspaceId, context), {
      workspaceId,
      sessionId: context.req.param("sessionId"),
      serverName: context.req.param("serverName"),
      method: request.method,
      headers: request.headers,
      body: () => bufferRequestBody(request),
      callerKind: "http",
    });
  });
  return routes;
}

export interface McpProxyBinding {
  fetch(request: Request): Promise<Response>;
}

/**
 * The in-process counterpart of the HTTP route, for a host-side harness:
 * the caller is the platform's own code (a service binding or a direct
 * call), so the workspace, Session and server ride on `x-oma-*` headers
 * instead of an authenticated path. Those headers never reach the upstream.
 */
export function createMcpProxyBinding(
  portsFor: (workspaceId: string) => McpProxyPorts | Promise<McpProxyPorts>,
): McpProxyBinding {
  return {
    async fetch(request) {
      const workspaceId = request.headers.get("x-oma-tenant");
      const sessionId = request.headers.get("x-oma-session");
      const serverName = request.headers.get("x-oma-mcp-server");
      const agent = rosterMemberHeaders(request.headers);
      if (!workspaceId || !sessionId || !serverName || agent === "invalid") {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      return forwardMcpProxyRequest(await portsFor(workspaceId), {
        workspaceId,
        sessionId,
        serverName,
        ...(agent !== undefined && { agent }),
        method: request.method,
        headers: request.headers,
        body: () => bufferRequestBody(request),
        callerKind: "rpc-mcp",
      });
    },
  };
}

/** `x-oma-agent-id` and `x-oma-agent-version` name a pinned roster member;
 * they come together, and the version is a positive integer. */
function rosterMemberHeaders(headers: Headers): { id: string; version: number } | undefined | "invalid" {
  const id = headers.get("x-oma-agent-id");
  const version = headers.get("x-oma-agent-version");
  if (id === null && version === null) return undefined;
  if (id === null || version === null || !/^\d+$/.test(version) || Number(version) < 1) return "invalid";
  return { id, version: Number(version) };
}
