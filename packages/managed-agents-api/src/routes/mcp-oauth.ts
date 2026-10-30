/**
 * OpenMA extension, not part of the Anthropic Managed Agents API:
 *
 *   POST /v1/oma/oauth/authorize   { mcp_server_url, vault_id, credential_id?,
 *                                    redirect_uri?, client_id?, client_secret? }
 *        → { authorization_url }
 *   GET  /v1/oma/oauth/callback?code&state
 *
 * Browser OAuth 2.1 (Authorization Code + PKCE) for an MCP server. The
 * approval is stored as a managed `mcp_oauth` Vault credential with refresh
 * metadata; the egress and MCP proxies refresh it on 401. Authorization is a
 * POST so a pinned `client_secret` never travels in a URL.
 */
import { Hono, type Context } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { mcpOAuthAuthorizeBodySchema } from "../contracts/mcp-oauth";
import { apiError, invalidRequest, notFound } from "../errors";
import type { McpOAuthApplicationPort } from "../ports/mcp-oauth";

const CALLBACK_PATH = "/v1/oma/oauth/callback";

export interface McpOAuthRouteOptions {
  /**
   * Origins, besides this service's own, a Console may run on. `redirect_uri`
   * must be an http(s) URL on one of them; the popup page reports the result
   * only to that origin.
   */
  consoleOrigins: readonly string[] | ((context: Context) => readonly string[]);
}

function callbackUri(requestUrl: string): string {
  return `${new URL(requestUrl).origin}${CALLBACK_PATH}`;
}

/** JSON for an inline <script>, safe against `</script>` and HTML parsing. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function failurePage(title: string, detail: string): string {
  return `<html><body><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></body></html>`;
}

/**
 * Popup completion page. It notifies the Console, and only the Console
 * origin, by `postMessage` and by a same-origin `BroadcastChannel`
 * ("openma-oauth", which survives a provider's Cross-Origin-Opener-Policy
 * severing `window.opener`), then closes; with neither transport it
 * navigates to the validated `fallbackUrl`.
 */
function completionPage(
  message: Record<string, unknown>,
  serviceName: string,
  consoleOrigin: string,
  fallbackUrl: string,
): string {
  return `<html><body>
<p>Connected to ${escapeHtml(serviceName)}. Closing…</p>
<script>
(function(){
  var msg = ${scriptJson(message)};
  var notified = false;
  try { if (window.opener && !window.opener.closed) { window.opener.postMessage(msg, ${scriptJson(consoleOrigin)}); notified = true; } } catch (e) {}
  try { if (window.location.origin === ${scriptJson(consoleOrigin)}) { var bc = new BroadcastChannel("openma-oauth"); bc.postMessage(msg); bc.close(); notified = true; } } catch (e) {}
  if (notified) { window.close(); } else { window.location.href = ${scriptJson(fallbackUrl)}; }
})();
</script>
</body></html>`;
}

function userIdOf(c: Context): string | null {
  const userId = (c.var as { user_id?: unknown }).user_id;
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

export function buildMcpOAuthRoutes(
  source: ApplicationPortSource<McpOAuthApplicationPort>,
  options: McpOAuthRouteOptions,
): Hono {
  const app = new Hono();
  // Platform error handlers may expose exception messages. Keep the OAuth
  // boundary generic even for unexpected adapter or persistence failures.
  app.onError((_error, c) => c.json(apiError("MCP OAuth operation failed"), 500));

  /** The return URL when it is http(s) on this service or a Console origin. */
  function allowedReturnTo(c: Context, value: string | undefined): URL | null {
    const self = new URL(c.req.url).origin;
    const consoleOrigins = typeof options.consoleOrigins === "function"
      ? options.consoleOrigins(c)
      : options.consoleOrigins;
    let url: URL;
    try {
      url = new URL(value ?? `${self}/`);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.origin !== self && !consoleOrigins.includes(url.origin)) return null;
    return url;
  }

  app.post("/authorize", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    const parsed = mcpOAuthAuthorizeBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(invalidRequest("Body must be { mcp_server_url, vault_id, credential_id?, redirect_uri?, client_id?, client_secret? }"), 400);
    }
    const input = parsed.data;
    const returnTo = allowedReturnTo(c, input.redirect_uri);
    if (returnTo === null) {
      return c.json(invalidRequest("redirect_uri must be an http(s) URL on this service or a configured Console origin"), 400);
    }
    const result = await resolveApplicationPort(source, c).authorize({
      vaultId: input.vault_id,
      mcpServerUrl: input.mcp_server_url,
      returnTo: returnTo.toString(),
      callbackUri: callbackUri(c.req.url),
      userId: userIdOf(c),
      ...(input.credential_id !== undefined && { credentialId: input.credential_id }),
      ...(input.client_id !== undefined && { clientId: input.client_id }),
      ...(input.client_secret !== undefined && { clientSecret: input.client_secret }),
    });
    switch (result.type) {
      case "redirect":
        return c.json({ authorization_url: result.authorizationUrl }, 200);
      case "not_found":
        return c.json(notFound("Vault or credential was not found"), 404);
      case "invalid_request":
        return c.json(invalidRequest(result.message), 400);
      case "discovery_failed":
        return c.json(apiError(`OAuth discovery for the MCP server failed (${result.reason})`), 502);
      case "client_unavailable":
        return c.json(apiError(result.message), 501);
    }
  });

  app.get("/callback", async (c) => {
    const error = c.req.query("error");
    if (error) {
      // Only the OAuth error code (RFC 6749 §4.1.2.1), not provider prose.
      const code = /^[a-z_]{1,64}$/.test(error) ? error : "authorization_failed";
      return c.html(failurePage("Authorization failed", code), 400);
    }
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json(invalidRequest("code and state are required"), 400);
    const result = await resolveApplicationPort(source, c).complete({
      code,
      state,
      callbackUri: callbackUri(c.req.url),
      userId: userIdOf(c),
    });
    switch (result.type) {
      case "invalid_state":
        return c.json(invalidRequest("Invalid or expired OAuth state"), 400);
      case "token_exchange_failed":
        return c.html(failurePage("Token exchange failed", result.reason), 502);
      case "not_found":
        return c.html(failurePage("Authorization failed", "vault_not_found"), 404);
      case "invalid_request":
        return c.html(failurePage("Authorization failed", "invalid_request"), 400);
      case "archive_failed":
        return c.html(failurePage(
          "Connected, but replaced credentials are still active",
          `Archive ${result.unarchivedCredentialIds.join(", ")} in vault ${result.vaultId}.`,
        ), 500);
      case "connected": {
        // The return URL was validated at authorize time and sealed in state.
        const returnTo = allowedReturnTo(c, result.returnTo);
        if (returnTo === null) return c.json(invalidRequest("Invalid or expired OAuth state"), 400);
        const fallback = new URL(returnTo);
        fallback.searchParams.set("oauth", "success");
        fallback.searchParams.set("service", result.serviceName);
        fallback.searchParams.set("probe_ok", result.probeOk ? "1" : "0");
        if (result.probeReason) fallback.searchParams.set("probe_reason", result.probeReason);
        return c.html(completionPage({
          type: "oauth_complete",
          service: result.serviceName,
          vault_id: result.vaultId,
          credential_id: result.credentialId,
          probe_ok: result.probeOk,
          probe_reason: result.probeReason ?? null,
        }, result.serviceName, returnTo.origin, fallback.toString()));
      }
    }
  });

  return app;
}
