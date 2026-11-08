import type { ForwardOutcome } from "@open-managed-agents/managed-credential-resolver";
import type { McpProxyFinalResult } from "@open-managed-agents/mcp-access-loss";
import type { ReplayableBody } from "./forward";
import { refreshLegacyCredential } from "./legacy-credential-refresh";
import type { McpProxyPorts } from "./mcp-proxy-ports";
import type { BearerMcpTarget, McpProxyTarget } from "./mcp-proxy-target";
import { sendMcpUpstream } from "./mcp-upstream";

export interface McpProxyExchange {
  workspaceId: string;
  target: McpProxyTarget;
  method: string;
  headers: Headers;
  body: ReplayableBody;
  /** Log correlation only. */
  audit: { sessionId?: string; serverName?: string; callerKind: "http" | "rpc-mcp" | "rpc-outbound" };
  /** Sees the final upstream response (access-loss classification). The
   * body is then buffered; without it the response streams through. */
  onFinal?: (result: McpProxyFinalResult) => Promise<void>;
}

/**
 * One proxied MCP exchange: inject the target's credential and, on a 401 from
 * a refreshable credential, refresh once and retry. Only a 401 refreshes: a
 * 403 is a permission decision, and rotating the token on it would write the
 * Vault on every forbidden request without ever recovering.
 */
export async function forwardMcpProxyTarget(
  ports: Pick<McpProxyPorts, "legacyCredentials" | "managedCredentials" | "log" | "fetch">,
  exchange: McpProxyExchange,
): Promise<Response> {
  const started = Date.now();
  const { target } = exchange;
  const send = (accessToken: string | null) => sendMcpUpstream({
    upstreamUrl: target.upstreamUrl,
    method: exchange.method,
    headers: exchange.headers,
    body: exchange.body,
    accessToken,
    ...(ports.fetch !== undefined && { fetcher: ports.fetch }),
  });
  const outcome = target.upstreamToken === null
    ? sentOnce(await send(null))
    : "managed" in target
      ? await ports.managedCredentials().forward(exchange.workspaceId, target.managed, send)
      : await forwardWithLegacyRefresh(ports, exchange.workspaceId, target, send);
  logExchange(ports.log, exchange, outcome, started);
  return finish(outcome, exchange.onFinal);
}

function sentOnce(response: Response): ForwardOutcome {
  return { response, refreshed: false, refreshFailed: false, refreshFailureCode: null };
}

/** A refused refresh re-sends with the original token so the caller sees the
 * upstream's own rejection. */
async function forwardWithLegacyRefresh(
  ports: Pick<McpProxyPorts, "legacyCredentials" | "fetch">,
  workspaceId: string,
  target: BearerMcpTarget,
  send: (accessToken: string) => Promise<Response>,
): Promise<ForwardOutcome> {
  const first = await send(target.upstreamToken);
  if (first.status !== 401 || target.refresh === undefined) return sentOnce(first);
  await first.body?.cancel().catch(() => undefined);
  const failure: { code: string | null } = { code: null };
  const fresh = await refreshLegacyCredential(
    { credentials: ports.legacyCredentials, ...(ports.fetch !== undefined && { fetch: ports.fetch }) },
    workspaceId,
    target.refresh,
    target.upstreamToken,
    failure,
  );
  if (fresh === null) {
    return { response: await send(target.upstreamToken), refreshed: false, refreshFailed: true, refreshFailureCode: failure.code };
  }
  return { response: await send(fresh), refreshed: true, refreshFailed: false, refreshFailureCode: null };
}

function logExchange(
  log: McpProxyPorts["log"],
  exchange: McpProxyExchange,
  outcome: ForwardOutcome,
  started: number,
): void {
  let host: string | undefined;
  try {
    host = new URL(exchange.target.upstreamUrl).hostname;
  } catch {
    host = undefined;
  }
  const fields = {
    op: outcome.refreshFailed ? "mcp_proxy.refresh_failed" : "mcp_proxy.forward",
    caller: exchange.audit.callerKind,
    tenant_id: exchange.workspaceId,
    session_id: exchange.audit.sessionId,
    server: exchange.audit.serverName,
    host,
    method: exchange.method,
    status: outcome.response.status,
    refreshed: outcome.refreshed,
    ms: Date.now() - started,
  };
  if (outcome.refreshFailed) log.warn(fields, "mcp_proxy refresh failed; returning the upstream rejection");
  else log.info(fields, outcome.refreshed ? "mcp_proxy forward (after refresh)" : "mcp_proxy forward");
}

async function finish(
  outcome: ForwardOutcome,
  onFinal: McpProxyExchange["onFinal"],
): Promise<Response> {
  if (onFinal === undefined) return outcome.response;
  const { response } = outcome;
  const bodyText = await response.text();
  await onFinal({
    status: response.status,
    bodyText,
    refreshed: outcome.refreshed,
    refreshFailed: outcome.refreshFailed,
    refreshFailureCode: outcome.refreshFailureCode,
  });
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "transfer-encoding"]) headers.delete(name);
  return new Response(bodyText, { status: response.status, statusText: response.statusText, headers });
}
