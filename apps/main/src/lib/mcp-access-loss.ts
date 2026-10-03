import {
  createAccessLossRuntime,
  type AccessLossRuntime,
} from "@open-managed-agents/mcp-access-loss";
import type { Env } from "@open-managed-agents/shared";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

/**
 * Cloudflare managed-MCP access-loss runtime. Scope rows live in
 * INTEGRATIONS_DB. Wakeups live on the session's Durable Object, not in D1.
 */
const runtimes = new WeakMap<D1Database, AccessLossRuntime>();

export function createCloudflareAccessLossRuntime(
  env: Env,
  tenantDb: D1Database,
): AccessLossRuntime {
  const existing = runtimes.get(tenantDb);
  if (existing) return existing;
  const tenantSql = new CfD1SqlClient(tenantDb);
  const integrationsSql = env.INTEGRATIONS_DB
    ? new CfD1SqlClient(env.INTEGRATIONS_DB)
    : tenantSql;
  const runtime = createAccessLossRuntime({
    tenantSql,
    integrationsSql,
    cancelWakeups: (input) => cancelSessionWakeups(env, input.sessionId),
  });
  runtimes.set(tenantDb, runtime);
  return runtime;
}

async function cancelSessionWakeups(
  env: Env,
  sessionId: string,
): Promise<{ cancelled: number }> {
  const fetcher = sessionFetcher(env);
  if (!fetcher) return { cancelled: 0 };
  const response = await fetcher.fetch(
    `https://sandbox/sessions/${encodeURIComponent(sessionId)}/wakeups/cancel`,
    { method: "POST" },
  );
  if (response.status === 404) return { cancelled: 0 };
  if (!response.ok) {
    throw new Error(`session wakeup cancel failed: ${response.status}`);
  }
  const body = await response.json() as { cancelled?: unknown };
  return { cancelled: typeof body.cancelled === "number" ? body.cancelled : 0 };
}

function sessionFetcher(env: Env): {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
} | null {
  const service = (env as unknown as Record<string, Fetcher | undefined>).SANDBOX_sandbox_default;
  if (service) return service;
  if (!env.SESSION_DO) return null;
  return {
    fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/sessions\/([^/]+)\/(.*)/);
      if (!match) return Promise.resolve(new Response("Not found", { status: 404 }));
      const [, sessionId, rest] = match;
      const decoded = decodeURIComponent(sessionId ?? "");
      const stub = env.SESSION_DO!.get(env.SESSION_DO!.idFromName(decoded));
      return stub.fetch(new Request(`http://internal/${rest}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      }));
    },
  };
}
