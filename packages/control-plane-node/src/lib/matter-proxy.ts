import { timingSafeEqual, createHash } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { proxyUpstream } from "@open-managed-agents/http-routes/proxy";

/**
 * `/matter/*` → the OpenMatter service (apps/matter), for the Console.
 *
 * The control plane authenticates the user first; the proxy then drops the
 * user's own credentials and tells Matter who is asking through headers
 * Matter trusts only alongside the shared secret (`trustedProxyPrincipal`
 * in apps/matter). Header names must match `MATTER_PROXY_HEADERS` there.
 */
export const MATTER_PROXY_HEADERS = {
  secret: "x-matter-proxy-secret",
  tenant: "x-oma-tenant-id",
  user: "x-oma-user-id",
} as const;

/** Never forwarded: the caller's credentials and any identity headers a
 * caller may try to set itself. Hop-by-hop headers are `proxyUpstream`'s. */
const WITHHELD_REQUEST_HEADERS: readonly string[] = [
  "cookie",
  "authorization",
  "x-api-key",
  "x-active-tenant",
  "proxy-authorization",
  ...Object.values(MATTER_PROXY_HEADERS),
];

export interface MatterProxyOptions {
  /** Matter's origin (and optional base path), without a trailing slash. */
  readonly url: string;
  readonly proxySecret: string;
  readonly fetcher?: typeof fetch;
}

export function buildMatterProxyRoutes(options: MatterProxyOptions) {
  const routes = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  routes.all("/*", async (c) => {
    const incoming = new URL(c.req.url);
    const rest = incoming.pathname.replace(/^\/matter(?=\/|$)/, "") || "/";
    const target = `${options.url}${rest}${incoming.search}`;

    const set: Record<string, string> = {
      [MATTER_PROXY_HEADERS.secret]: options.proxySecret,
      [MATTER_PROXY_HEADERS.tenant]: c.var.tenant_id,
    };
    const userId = c.var.user_id;
    if (userId) set[MATTER_PROXY_HEADERS.user] = userId;

    const method = c.req.method.toUpperCase();
    let upstream: Response;
    try {
      upstream = await proxyUpstream({
        url: target,
        method,
        headers: c.req.raw.headers,
        body: method === "GET" || method === "HEAD" ? null : await c.req.raw.arrayBuffer(),
        set,
        drop: WITHHELD_REQUEST_HEADERS,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      });
    } catch {
      return c.json({ error: "matter_unavailable" }, 502);
    }
    // Matter's session cookies belong to Matter's origin, not the Console's.
    const out = new Headers(upstream.headers);
    out.delete("set-cookie");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });
  return routes;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Authenticates the Matter service calling the API as one workspace: the
 * same secret and tenant header the proxy sends to Matter, in the other
 * direction. Any other request falls through to `auth`. The tenant header
 * is trusted only with the secret; `buildMatterProxyRoutes` never forwards
 * a caller's own copy of either header.
 */
export function matterTrustedAuth(
  proxySecret: string,
  auth: MiddlewareHandler,
): MiddlewareHandler<{ Variables: { tenant_id: string; user_id?: string } }> {
  return async (c, next) => {
    const given = c.req.header(MATTER_PROXY_HEADERS.secret);
    if (given !== undefined && proxySecret.length > 0) {
      const tenant = c.req.header(MATTER_PROXY_HEADERS.tenant) ?? "";
      if (!timingSafeEqual(digest(given), digest(proxySecret)) || tenant === "") {
        return c.json({ type: "error", error: { type: "authentication_error", message: "Invalid Matter credentials" } }, 401);
      }
      c.set("tenant_id", tenant);
      return next();
    }
    return auth(c, next);
  };
}

/**
 * `/webhooks/gitlab/*` → Matter, unauthenticated: GitLab calls it directly
 * and Matter checks each connection's own webhook secret
 * (`X-Gitlab-Token`). Credentials and Matter's trust headers are dropped.
 */
export function buildMatterWebhookRoutes(options: MatterProxyOptions) {
  const routes = new Hono();
  routes.post("/*", async (c) => {
    const incoming = new URL(c.req.url);
    let upstream: Response;
    try {
      upstream = await proxyUpstream({
        url: `${options.url}${incoming.pathname}${incoming.search}`,
        method: "POST",
        headers: c.req.raw.headers,
        body: await c.req.raw.arrayBuffer(),
        drop: WITHHELD_REQUEST_HEADERS,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      });
    } catch {
      return c.json({ error: "matter_unavailable" }, 502);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  });
  return routes;
}
