import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { McpOAuthCliService, McpOAuthCliSecrets, McpOAuthCliActor } from "@open-managed-agents/managed-agents-application";
import { resolveApplicationPort, type ApplicationPortSource } from "../application-port-source";
import { apiError, invalidRequest, notFound } from "../errors";
import { mcpOAuthAuthorizeBodySchema } from "../contracts/mcp-oauth";

const CALLBACK_PATH = "/v1/oma/oauth/callback";
const startSchema = mcpOAuthAuthorizeBodySchema.omit({ redirect_uri: true }).strict();
const claimSchema = z.object({ flow_id: z.string().min(1), claim_token: z.string().min(1) }).strict();

/** Must be mounted BEFORE auth. Only a valid sealed CLI discriminator is handled;
 * Console/invalid state falls through to the unchanged authenticated callback. */
export function buildMcpOAuthCliCallback(source: ApplicationPortSource<McpOAuthCliService>): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "GET" || c.req.path !== CALLBACK_PATH || !c.req.query("state")) return next();
    try {
      const result = await resolveApplicationPort(source, c).callback({ state: c.req.query("state")!, code: c.req.query("code"), error: c.req.query("error"), callbackUri: `${new URL(c.req.url).origin}${CALLBACK_PATH}` });
      if (result === null) return next();
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      return result.type === "completed"
        ? c.html("<html><body><p>Authorization processed. Return to your terminal for the result.</p></body></html>")
        : c.json(invalidRequest("Invalid or expired CLI OAuth flow"), 400);
    } catch {
      return c.json(apiError("MCP OAuth operation failed"), 500);
    }
  };
}

export function buildMcpOAuthCliRoutes(source: ApplicationPortSource<McpOAuthCliService>, secrets: Pick<McpOAuthCliSecrets, "hash">): Hono {
  const app = new Hono();
  app.onError((_error, c) => c.json(apiError("MCP OAuth operation failed"), 500));
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  async function actor(c: Context): Promise<McpOAuthCliActor | null> {
    const key = c.req.header("x-api-key");
    const vars = c.var as { tenant_id?: string; user_id?: string };
    if (!key || !vars.tenant_id) return null;
    return { workspaceId: vars.tenant_id, userId: vars.user_id ?? null, keyHash: await secrets.hash(key) };
  }
  app.post("/authorize", async (c) => {
    const identity = await actor(c);
    if (identity === null) return c.json(invalidRequest("CLI OAuth requires an authenticated x-api-key"), 400);
    const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(invalidRequest("Invalid CLI OAuth authorization body"), 400);
    const input = parsed.data;
    const result = await resolveApplicationPort(source, c).start({ actor: identity, vaultId: input.vault_id, mcpServerUrl: input.mcp_server_url, callbackUri: `${new URL(c.req.url).origin}${CALLBACK_PATH}`, ...(input.client_id && { clientId: input.client_id }), ...(input.client_secret && { clientSecret: input.client_secret }), ...(input.credential_id && { credentialId: input.credential_id }) });
    switch (result.type) {
      case "started": return c.json({ authorization_url: result.authorizationUrl, flow_id: result.flowId, claim_token: result.claimToken, expires_at: result.expiresAt, interval_seconds: 2 });
      case "not_found": return c.json(notFound("Vault or credential was not found"), 404);
      case "invalid_request": return c.json(invalidRequest(result.message), 400);
      case "discovery_failed": return c.json(apiError(`MCP OAuth discovery failed (${result.reason})`), 502);
      case "client_unavailable": return c.json(apiError(result.message), 501);
    }
  });
  app.post("/result", async (c) => {
    const identity = await actor(c);
    if (identity === null) return c.json(invalidRequest("CLI OAuth requires an authenticated x-api-key"), 400);
    const parsed = claimSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(invalidRequest("Invalid CLI OAuth claim body"), 400);
    const result = await resolveApplicationPort(source, c).poll({ actor: identity, flowId: parsed.data.flow_id, claimToken: parsed.data.claim_token });
    switch (result.type) {
      case "invalid_flow": return c.json(invalidRequest("Invalid or expired CLI OAuth flow"), 400);
      case "ready": return c.json({ status: "ready", credential_id: result.credentialId });
      case "pending": return c.json({ status: "pending" });
      case "failed": return c.json({ status: "failed" });
    }
  });
  return app;
}
