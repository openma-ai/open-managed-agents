/**
 * OpenMA extension, not part of the Anthropic Managed Agents API:
 *
 *   GET /v1/oma/oauth/authorize?mcp_server_url&vault_id[&credential_id]
 *                              [&redirect_uri][&client_id][&client_secret]
 *   GET /v1/oma/oauth/callback?code&state
 *
 * Browser OAuth 2.1 (Authorization Code + PKCE) for an MCP server. The
 * approval is stored as a managed `mcp_oauth` Vault credential with refresh
 * metadata; the egress and MCP proxies refresh it on 401.
 */
import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { apiError, invalidRequest, notFound } from "../errors";
import type { McpOAuthApplicationPort } from "../ports/mcp-oauth";

const CALLBACK_PATH = "/v1/oma/oauth/callback";

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
  return `<html><body><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p><script>window.close()</script></body></html>`;
}

/**
 * Popup completion page. It notifies the opener by `postMessage` and by a
 * same-origin `BroadcastChannel("openma-oauth")` (the latter survives a
 * provider's Cross-Origin-Opener-Policy severing `window.opener`), then
 * closes; with neither transport it navigates to `fallbackUrl`.
 */
function completionPage(message: Record<string, unknown>, serviceName: string, fallbackUrl: string): string {
  return `<html><body>
<p>Connected to ${escapeHtml(serviceName)}. Closing…</p>
<script>
(function(){
  var msg = ${scriptJson(message)};
  var notified = false;
  try { if (window.opener && !window.opener.closed) { window.opener.postMessage(msg, "*"); notified = true; } } catch (e) {}
  try { var bc = new BroadcastChannel("openma-oauth"); bc.postMessage(msg); bc.close(); notified = true; } catch (e) {}
  if (notified) { window.close(); } else { window.location.href = ${scriptJson(fallbackUrl)}; }
})();
</script>
</body></html>`;
}

export function buildMcpOAuthRoutes(
  source: ApplicationPortSource<McpOAuthApplicationPort>,
): Hono {
  const app = new Hono();

  app.get("/authorize", async (c) => {
    const mcpServerUrl = c.req.query("mcp_server_url");
    const vaultId = c.req.query("vault_id");
    if (!mcpServerUrl || !vaultId) {
      return c.json(invalidRequest("mcp_server_url and vault_id are required"), 400);
    }
    const credentialId = c.req.query("credential_id");
    const clientId = c.req.query("client_id");
    const clientSecret = c.req.query("client_secret");
    const result = await resolveApplicationPort(source, c).authorize({
      vaultId,
      mcpServerUrl,
      returnTo: c.req.query("redirect_uri") || `${new URL(c.req.url).origin}/`,
      callbackUri: callbackUri(c.req.url),
      ...(credentialId && { credentialId }),
      ...(clientId && { clientId }),
      ...(clientSecret && { clientSecret }),
    });
    switch (result.type) {
      case "redirect":
        return c.redirect(result.authorizationUrl);
      case "not_found":
        return c.json(notFound(`Vault ${vaultId} was not found`), 404);
      case "invalid_request":
        return c.json(invalidRequest(result.message), 400);
      case "discovery_failed":
        return c.json(apiError(`OAuth discovery failed: ${result.message}`), 502);
      case "client_unavailable":
        return c.json(apiError(result.message), 501);
    }
  });

  app.get("/callback", async (c) => {
    const error = c.req.query("error");
    if (error) {
      return c.html(failurePage("Authorization failed", c.req.query("error_description") || error), 400);
    }
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return c.json(invalidRequest("code and state are required"), 400);
    const result = await resolveApplicationPort(source, c).complete({
      code,
      state,
      callbackUri: callbackUri(c.req.url),
    });
    switch (result.type) {
      case "invalid_state":
        return c.json(invalidRequest("Invalid or expired OAuth state"), 400);
      case "token_exchange_failed":
        return c.html(failurePage("Token exchange failed", result.message), 502);
      case "not_found":
        return c.html(failurePage("Authorization failed", "The Vault no longer exists"), 404);
      case "invalid_request":
        return c.html(failurePage("Authorization failed", result.message), 400);
      case "connected": {
        const fallback = new URL(result.returnTo);
        fallback.searchParams.set("oauth", "success");
        fallback.searchParams.set("service", result.serviceName);
        fallback.searchParams.set("probe_ok", result.probeOk ? "1" : "0");
        if (result.probeMessage) fallback.searchParams.set("probe_message", result.probeMessage);
        return c.html(completionPage({
          type: "oauth_complete",
          service: result.serviceName,
          vault_id: result.vaultId,
          credential_id: result.credentialId,
          probe_ok: result.probeOk,
          probe_message: result.probeMessage ?? null,
        }, result.serviceName, fallback.toString()));
      }
    }
  });

  return app;
}
