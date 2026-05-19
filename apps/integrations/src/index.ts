import { Hono } from "hono";
import type { Env } from "./env";
import linearPublications from "./routes/linear/publications";
import githubPublications from "./routes/github/publications";
import slackPublications from "./routes/slack/publications";
import slackSetupPage from "./routes/slack/setup-page";
import githubManifest from "./routes/github/manifest";
import { buildProviders } from "./providers";
import { buildContainer } from "./wire";
import { CfInstallBridge } from "./cf-install-bridge";
import { webhookRateLimitMiddleware, shouldDropForTenantRateLimit } from "./webhook-rate-limit";
import { linearDispatchTick } from "@open-managed-agents/scheduler/jobs/linear-dispatch";
import { getLogger } from "@open-managed-agents/observability";
import { buildIntegrationsGatewayRoutes } from "@open-managed-agents/http-routes";

const log = getLogger("apps.integrations");

// Integrations gateway worker: receives 3rd-party webhooks (Linear + GitHub +
// Slack), runs OAuth/install flows for installations, and hosts the MCP servers
// that expose external APIs to agent sessions.
//
// Most route bodies live in @open-managed-agents/http-routes via
// `buildIntegrationsGatewayRoutes` — this file just wires the CF-flavored
// install bridge + provider webhook handlers + per-IP/per-tenant rate
// limiting onto that. The publications + manifest-start endpoints stay
// here because they're CF-specific (return-shape preserved verbatim).
// Slack setup-page also stays as its own file because it surfaces a
// manifest-launch URL that isn't yet plumbed through the package; the
// rest of the providers' setup pages run from the package.

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// TEMP debug — staging only, no auth. Read the latest slack_apps row and
// dump decrypted Client Secret + Signing Secret for the bad_client_secret
// investigation. Revert before merging this branch to main.
app.get("/debug/slack-apps-latest", async (c) => {
  const origin = c.env.GATEWAY_ORIGIN ?? "";
  if (!/\bstaging\b/i.test(origin)) return c.text("not on staging", 404);
  const db = c.env.INTEGRATIONS_DB;
  if (!db) return c.json({ error: "no INTEGRATIONS_DB binding" }, 500);
  const row = await db
    .prepare("SELECT id, client_id, client_secret_cipher, signing_secret_cipher, created_at FROM slack_apps ORDER BY created_at DESC LIMIT 1")
    .first<{ id: string; client_id: string; client_secret_cipher: string; signing_secret_cipher: string; created_at: number }>();
  if (!row) return c.json({ error: "no rows" }, 404);
  const { WebCryptoAesGcm } = await import("@open-managed-agents/integrations-adapters-cf");
  const crypto = new WebCryptoAesGcm(c.env.PLATFORM_ROOT_SECRET, "integrations.tokens");
  const cs = await crypto.decrypt(row.client_secret_cipher);
  const ss = await crypto.decrypt(row.signing_secret_cipher);
  const hex = (s: string) =>
    Array.from(new TextEncoder().encode(s))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
  return c.json({
    id: row.id,
    client_id: row.client_id,
    created_at: new Date(row.created_at).toISOString(),
    client_secret: { plaintext: cs, length: cs.length, bytes_hex: hex(cs), cipher_b64url_len: row.client_secret_cipher.length },
    signing_secret: { plaintext: ss, length: ss.length, bytes_hex: hex(ss), cipher_b64url_len: row.signing_secret_cipher.length },
  });
});

// TEMP debug — staging only. Probe the Slack MCP server end-to-end:
//  1. fetch the user vault cred (xoxp- token) for the latest installation,
//  2. POST mcp.slack.com/mcp with that bearer + a tools/list JSON-RPC,
//  3. return upstream status + body verbatim.
// Pinpoints whether MCP setup fails because of bad token, missing scope,
// proxy mismatch, or something else. Revert before merge.
app.get("/debug/slack-mcp-probe", async (c) => {
  const origin = c.env.GATEWAY_ORIGIN ?? "";
  if (!/\bstaging\b/i.test(origin)) return c.text("not on staging", 404);
  const idb = c.env.INTEGRATIONS_DB;
  const adb = c.env.AUTH_DB;
  if (!idb || !adb) return c.json({ error: "missing DB bindings" }, 500);
  // Latest slack installation → user vault id.
  const inst = await idb
    .prepare("SELECT id, vault_id, bot_vault_id, workspace_id FROM slack_installations ORDER BY created_at DESC LIMIT 1")
    .first<{ id: string; vault_id: string; bot_vault_id: string | null; workspace_id: string }>();
  if (!inst) return c.json({ error: "no slack_installations rows" }, 404);
  // Find the cred attached to that user vault that matches mcp.slack.com.
  const cred = await adb
    .prepare("SELECT id, auth FROM credentials WHERE vault_id = ? AND mcp_server_url = 'https://mcp.slack.com/mcp' AND archived_at IS NULL LIMIT 1")
    .bind(inst.vault_id)
    .first<{ id: string; auth: string }>();
  if (!cred) return c.json({ error: "no credential for mcp.slack.com on user vault", vault_id: inst.vault_id }, 404);
  // The auth column may be plaintext JSON OR encrypted (post-secrets PR).
  // Try parse-as-json first; if shape's wrong, decrypt.
  const { WebCryptoAesGcm } = await import("@open-managed-agents/integrations-adapters-cf");
  let authJson: { token?: string; access_token?: string; bearer_token?: string; type?: string };
  try {
    authJson = JSON.parse(cred.auth);
    if (typeof (authJson as { type?: string }).type !== "string") throw new Error("not plaintext");
  } catch {
    const cryptoSvc = new WebCryptoAesGcm(c.env.PLATFORM_ROOT_SECRET, "credentials.auth");
    authJson = JSON.parse(await cryptoSvc.decrypt(cred.auth));
  }
  const token = authJson.token ?? authJson.access_token ?? authJson.bearer_token;
  if (!token) return c.json({ error: "credential has no token", auth_keys: Object.keys(authJson) }, 500);

  // Now probe mcp.slack.com/mcp directly with this token.
  const probe = await fetch("https://mcp.slack.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
      "authorization": `Bearer ${token}`,
      "user-agent": "oma-debug-probe/1.0",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const probeBody = await probe.text();
  return c.json({
    installation_id: inst.id,
    user_vault_id: inst.vault_id,
    credential_id: cred.id,
    token_prefix: token.slice(0, 8),
    token_length: token.length,
    token_starts_with_xoxp: token.startsWith("xoxp-"),
    upstream_status: probe.status,
    upstream_content_type: probe.headers.get("content-type"),
    upstream_www_authenticate: probe.headers.get("www-authenticate"),
    upstream_body: probeBody.slice(0, 2000),
  });
});

// Defense-in-depth: /admin/* endpoints never existed (or were intentionally
// removed). Prod env always 404. Staging env requires TEMP_DEBUG_TOKEN
// (`x-debug-token`) — wrong/missing token = 401. Correct token falls
// through; current routes resolve to 404 because no admin handler is
// mounted. Staging detection uses \bstaging\b word boundary so hosts like
// `stagecoach.openma.dev` are NOT misclassified as staging. Mounted before
// the gateway middleware so the cheap reject runs first.
app.all("/admin/*", (c) => {
  const origin = c.env.GATEWAY_ORIGIN ?? "";
  const isStaging = /\bstaging\b/i.test(origin);
  if (!isStaging) return c.notFound();
  const token = c.req.header("x-debug-token");
  const expected = c.env.TEMP_DEBUG_TOKEN;
  if (!token || !expected || token !== expected) {
    return c.text("Unauthorized", 401);
  }
  return c.notFound();
});

// Per-IP rate limit on webhook receivers. Mounted before the package
// gateway so the cheap reject runs first.
app.use("/linear/webhook/*", webhookRateLimitMiddleware);
app.use("/github/webhook/*", webhookRateLimitMiddleware);
app.use("/slack/webhook/*", webhookRateLimitMiddleware);

// Publications/manifest-start CF-side wrappers (kept). These accept
// formToken POSTs from the browser and publish setup flows. Mounted
// before the gateway catch-all so they always win.
app.route("/linear/publications", linearPublications);
app.route("/github/publications", githubPublications);
app.route("/github/manifest", githubManifest);
app.route("/slack/publications", slackPublications);
app.route("/slack-setup", slackSetupPage);

// Package routes: OAuth callbacks, setup pages, Linear MCP, GitHub
// internal refresh, webhook receivers. The CfInstallBridge wraps the
// in-process providers (no service-binding hop).
app.use("*", async (c, next) => {
  const env = c.env;
  const bridge = new CfInstallBridge({ env });
  const providers = buildProviders(env);
  const container = buildContainer(env);
  const gateway = buildIntegrationsGatewayRoutes({
    installBridge: bridge,
    jwt: container.jwt,
    webhooks: {
      linear: (req) => providers.linear.handleWebhook(req),
      github: (req) => providers.github.handleWebhook(req),
      slack: (req) => providers.slack.handleWebhook(req),
    },
    internalSecret: env.INTEGRATIONS_INTERNAL_SECRET ?? null,
    rateLimit: {
      shouldDropForTenant: (tenantId) => shouldDropForTenantRateLimit(env, tenantId),
    },
  });
  // Slack's deferredWork callback needs ctx.waitUntil on CF — we can't
  // hand the package routes raw access to executionCtx, so re-attach
  // here. The Slack route in the package fires deferredWork() in the
  // background; on CF we want it under waitUntil so the isolate stays
  // alive until it completes.
  const res = await gateway.fetch(c.req.raw, env, c.executionCtx);
  if (res.status !== 404) return res;
  return next();
});

/**
 * Cron entry point — same as before. Linear dispatch sweep.
 */
async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const tick = linearDispatchTick({
    resolveSweeper: async () => {
      const { linear } = buildProviders(env);
      return linear;
    },
  });
  ctx.waitUntil(
    tick().catch((err) => {
      log.error(
        { err, op: "linear-dispatch-cron.fatal", cron: controller.cron },
        "linear-dispatch tick failed",
      );
    }),
  );
}

export default {
  fetch: app.fetch,
  scheduled,
};
