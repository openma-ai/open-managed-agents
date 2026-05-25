/**
 * mock-services Worker — combines MCP server mock + OAuth provider mock for
 * e2e testing of paths the real OMA gateway can't reach in CI.
 *
 * Endpoints
 * ─────────
 *
 *   POST /oauth/authorize?client_id=...&redirect_uri=...&state=...
 *     → 302 to {redirect_uri}?code=mock_code_<random>&state=<state>
 *     The OAuth callback flow used by publication-first install.
 *
 *   POST /oauth/token
 *     Body: grant_type=authorization_code | refresh_token, ...standard fields
 *     → 200 {access_token, refresh_token, token_type:"Bearer", expires_in}
 *     Refresh-token grant rotates the refresh_token too (matches real Linear /
 *     Slack / GitHub behavior).
 *
 *   ALL /mcp/{scenario}/{tail...}
 *     scenario discriminator picks behavior, controllable per request:
 *     - `ok`         — always 200 with a tiny `tools/list` response
 *     - `401-once`   — first call per session returns 401 + WWW-Authenticate
 *                      with `error="invalid_token"`. Subsequent calls 200.
 *                      "Session" keyed by the bearer token: a new token gets
 *                      a fresh 401 budget.
 *     - `403-always` — every call returns 403 (tests the 403→refresh trigger
 *                      we added to mcp-proxy)
 *     - `expire/{ttl_seconds}` — bearer is valid for ttl_seconds from first
 *                      use, then 401 until a new bearer arrives. Lets you
 *                      script the refresh-token race.
 *
 *   GET /__/state — debug: dump the bearer→state map
 *   POST /__/reset — wipe state (test isolation)
 *
 * State per scenario is in a single MockStateDO. Each bearer token is a key;
 * the value tracks first-seen-at + call counts.
 */

export interface Env {
  MOCK_STATE: DurableObjectNamespace;
}

const ISSUED_CODES = new Set<string>(); // ephemeral; per-worker-instance memory

function bearerOf(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function randomToken(prefix: string): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    // ─── OAuth: /oauth/authorize ──────────────────────────────────────
    if (p === "/oauth/authorize" || p === "/oauth/authorize/") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state") ?? "";
      if (!redirectUri) return json({ error: "missing redirect_uri" }, 400);
      const code = randomToken("mock_code");
      ISSUED_CODES.add(code);
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      return Response.redirect(target.toString(), 302);
    }

    // ─── OAuth: /oauth/token ──────────────────────────────────────────
    if (p === "/oauth/token") {
      const body = await req.formData().catch(() => null);
      const params = body
        ? Object.fromEntries(body.entries())
        : (await req.json().catch(() => ({}))) as Record<string, string>;
      const grant = String(params["grant_type"] ?? "");

      if (grant === "authorization_code") {
        const code = String(params["code"] ?? "");
        // accept the issued code or any "mock_code_*" so the test can plug a
        // fixed value without round-tripping through /authorize first
        if (!code.startsWith("mock_code")) {
          return json({ error: "invalid_grant", error_description: "unknown code" }, 400);
        }
        ISSUED_CODES.delete(code);
        return json({
          access_token: randomToken("mock_at"),
          refresh_token: randomToken("mock_rt"),
          token_type: "Bearer",
          expires_in: 3600,
          scope: String(params["scope"] ?? "read write"),
        });
      }

      if (grant === "refresh_token") {
        const rt = String(params["refresh_token"] ?? "");
        if (!rt.startsWith("mock_rt")) {
          return json({ error: "invalid_grant", error_description: "unknown refresh_token" }, 400);
        }
        return json({
          access_token: randomToken("mock_at"),
          refresh_token: randomToken("mock_rt"),
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      return json({ error: "unsupported_grant_type", grant_type: grant }, 400);
    }

    // ─── MCP scenarios: /mcp/{scenario}/{tail} ────────────────────────
    if (p.startsWith("/mcp/")) {
      const parts = p.slice("/mcp/".length).split("/");
      const scenario = parts.shift() ?? "";
      const tail = parts.join("/");
      const dispatchUrl = new URL(`/dispatch/${tail}`, url.origin).toString();
      const stub = await env.MOCK_STATE.get(env.MOCK_STATE.idFromName(scenario)).fetch(
        dispatchUrl,
        {
          method: req.method,
          headers: req.headers,
          body: req.method === "GET" || req.method === "HEAD" ? null : await req.text(),
        },
      );
      return stub;
    }

    // ─── State inspectors ─────────────────────────────────────────────
    if (p === "/__/state") {
      // Aggregate across known scenario names (we just look at the well-known ones)
      const scenarios = ["ok", "401-once", "403-always", "expire"];
      const out: Record<string, unknown> = {};
      for (const s of scenarios) {
        const r = await env.MOCK_STATE.get(env.MOCK_STATE.idFromName(s))
          .fetch(new URL("/state", url.origin).toString());
        out[s] = await r.json();
      }
      return json(out);
    }
    if (p === "/__/reset") {
      const scenarios = ["ok", "401-once", "403-always", "expire"];
      for (const s of scenarios) {
        await env.MOCK_STATE.get(env.MOCK_STATE.idFromName(s))
          .fetch(new URL("/reset", url.origin).toString(), { method: "POST" });
      }
      return json({ ok: true });
    }

    // ─── Root: a short README ────────────────────────────────────────
    if (p === "/" || p === "/health") {
      return json({
        service: "oma-mock-services",
        endpoints: {
          oauth: ["GET /oauth/authorize", "POST /oauth/token"],
          mcp: [
            "ALL /mcp/ok/...",
            "ALL /mcp/401-once/...",
            "ALL /mcp/403-always/...",
            "ALL /mcp/expire/{ttl_seconds}/...",
          ],
          admin: ["GET /__/state", "POST /__/reset"],
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
};

// ─── Durable Object: per-scenario per-bearer state ───────────────────

export class MockStateDO {
  private state: DurableObjectState;
  // bearer → { firstSeenMs, callCount, scenarioMeta }
  private bearers = new Map<string, { firstSeenMs: number; callCount: number }>();
  // scenario name comes from DO id name (set by caller via idFromName)
  private scenario: string;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.scenario = state.id.name ?? "ok";
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/state") {
      return Response.json({
        scenario: this.scenario,
        bearers: Array.from(this.bearers.entries()).map(([t, s]) => ({
          token: `${t.slice(0, 12)}…`,
          firstSeenMs: s.firstSeenMs,
          callCount: s.callCount,
        })),
      });
    }
    if (url.pathname === "/reset" && req.method === "POST") {
      this.bearers.clear();
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/dispatch" && !url.pathname.startsWith("/dispatch/")) {
      return new Response("not found", { status: 404 });
    }

    const bearer = bearerOf(req) ?? "<no-bearer>";
    let entry = this.bearers.get(bearer);
    if (!entry) {
      entry = { firstSeenMs: Date.now(), callCount: 0 };
      this.bearers.set(bearer, entry);
    }
    entry.callCount += 1;

    switch (this.scenario) {
      case "ok":
        return mcpToolsList();

      case "401-once":
        if (entry.callCount === 1) {
          return new Response(
            JSON.stringify({ error: "invalid_token" }),
            {
              status: 401,
              headers: {
                "content-type": "application/json",
                "www-authenticate": 'Bearer error="invalid_token"',
              },
            },
          );
        }
        return mcpToolsList();

      case "403-always":
        return new Response(
          JSON.stringify({ error: "forbidden" }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          },
        );

      case "expire": {
        // path embeds /mcp/expire/{ttl}/... — read ttl from the first
        // segment of /dispatch/{ttl}/...
        const tail = url.pathname.slice("/dispatch/".length);
        const ttlMatch = /^(\d+)/.exec(tail);
        const ttl = ttlMatch ? Number(ttlMatch[1]) : 5;
        const ageMs = Date.now() - entry.firstSeenMs;
        if (ageMs > ttl * 1000) {
          return new Response(
            JSON.stringify({ error: "invalid_token", error_description: "expired" }),
            {
              status: 401,
              headers: {
                "content-type": "application/json",
                "www-authenticate": 'Bearer error="invalid_token"',
              },
            },
          );
        }
        return mcpToolsList();
      }

      default:
        return new Response("unknown scenario", { status: 404 });
    }
  }
}

function mcpToolsList(): Response {
  // Minimal MCP `tools/list` JSON-RPC response so a real MCP client treats
  // this as a valid server. The agent's MCP transport doesn't care about the
  // actual tools for these tests — what we're verifying is the gateway's
  // 401/403/expiry handling and refresh-token round-trip.
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "mock_echo",
            description: "Returns its input verbatim",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
        ],
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
