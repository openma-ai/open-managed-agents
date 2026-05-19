import { Hono } from "hono";
import type { Env } from "../../env";
import { buildProviders } from "../../providers";

// Slack publication-first install flow.
//
// Three steps, three endpoints:
//   1. POST /slack/publications/start
//      → INSERT slack_publications shell (status='pending_setup'),
//        returns { formToken, publicationId, callbackUrl, manifestLaunchUrl, ... }
//   2. POST /slack/publications/credentials
//      → PATCH client_id/secret/signing_secret onto the publication row
//        (encrypted), returns OAuth authorize URL.
//   3. GET  /slack/oauth/pub/:pubId/callback
//      → completes install: token exchange, installation/vaults/apps
//        materialized, status flips to 'live', redirects to Console.
//
// Compatibility shim: /start-a1 is preserved as an alias of /start so the
// existing console wizard's `api.slack.startA1(...)` calls keep working
// without a Console build coordinated to this server change. Console
// rev to use /start naturally on its next deploy.
//
// Auth: /start (and /start-a1) is internal-only (called by apps/main via
// service binding) and requires the shared header secret. /credentials is
// reachable directly from the user's browser (admin handoff page submits
// straight here without a session) — auth there is the formToken JWT itself.

const app = new Hono<{ Bindings: Env }>();

function requireInternalSecret(env: Env, headerValue: string | undefined): boolean {
  return Boolean(
    env.INTEGRATIONS_INTERNAL_SECRET &&
      headerValue === env.INTEGRATIONS_INTERNAL_SECRET,
  );
}

interface StartBody {
  userId: string;
  agentId: string;
  environmentId: string;
  personaName: string;
  personaAvatarUrl: string | null;
  returnUrl: string;
}

async function handleStart(c: import("hono").Context<{ Bindings: Env }>) {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json<StartBody>();
  if (!body.userId || !body.agentId || !body.environmentId || !body.personaName || !body.returnUrl) {
    return c.json(
      { error: "userId, agentId, environmentId, personaName, returnUrl required" },
      400,
    );
  }

  const { slack } = buildProviders(c.env);
  const result = await slack.startInstall({
    userId: body.userId,
    agentId: body.agentId,
    environmentId: body.environmentId,
    mode: "full",
    persona: { name: body.personaName, avatarUrl: body.personaAvatarUrl },
    returnUrl: body.returnUrl,
  });

  if (result.kind !== "step" || result.step !== "credentials_form") {
    return c.json({ error: "unexpected install result", result }, 500);
  }
  return c.json(result.data);
}

app.post("/start", handleStart);
// Compatibility alias — keeps the legacy console build working while it
// migrates to /start. Same body, same response.
app.post("/start-a1", handleStart);

interface SubmitCredentialsBody {
  formToken: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
}

app.post("/credentials", async (c) => {
  const body = await c.req.json<SubmitCredentialsBody>();
  if (!body.formToken || !body.clientId || !body.clientSecret || !body.signingSecret) {
    return c.json(
      {
        error: "formToken, clientId, clientSecret, signingSecret required",
        hint:
          "signingSecret comes from the Slack App's Basic Information page " +
          "(Signing Secret field). Slack uses this single value to sign all webhook events.",
      },
      400,
    );
  }

  const { slack } = buildProviders(c.env);

  let result;
  try {
    result = await slack.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: body.formToken,
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        signingSecret: body.signingSecret,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/JwtSigner\.verify/i.test(msg)) {
      return c.json(
        {
          error: "form_token_invalid",
          details: msg.replace(/.*JwtSigner\.verify:\s*/, ""),
          remediation: "Re-run slack publish to mint a fresh form token (TTL ~60 min).",
        },
        400,
      );
    }
    return c.json({ error: "credentials_failed", details: msg }, 400);
  }

  if (result.kind !== "step" || result.step !== "install_link") {
    return c.json({ error: "unexpected continue result", result }, 500);
  }
  return c.json(result.data);
});

interface HandoffLinkBody {
  formToken: string;
}

/**
 * POST /slack/publications/handoff-link
 * Body: { formToken } from a prior /start call.
 * Returns: { url, expiresInDays } — share this URL with a workspace admin.
 */
app.post("/handoff-link", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json<HandoffLinkBody>();
  if (!body.formToken) return c.json({ error: "formToken required" }, 400);

  const { slack } = buildProviders(c.env);

  let result;
  try {
    result = await slack.continueInstall({
      publicationId: null,
      payload: { kind: "handoff_link", formToken: body.formToken },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/JwtSigner\.verify/i.test(msg)) {
      return c.json(
        {
          error: "form_token_invalid",
          details: msg.replace(/.*JwtSigner\.verify:\s*/, ""),
          remediation: "Re-run slack publish to mint a fresh form token (TTL ~60 min).",
        },
        400,
      );
    }
    return c.json({ error: "handoff_failed", details: msg }, 400);
  }

  if (result.kind !== "step" || result.step !== "install_link") {
    return c.json({ error: "unexpected handoff result", result }, 500);
  }
  return c.json(result.data);
});

interface FormTokenBody {
  /** Forwarded from apps/main; identifies the publication owner. */
  userId: string;
  /** Optional — defaults to a Console-deep link if absent. */
  returnUrl?: string;
}

/**
 * POST /slack/publications/:id/form-token
 *
 * Re-issues a fresh formToken for an existing publication shell. Used by the
 * Console wizard's refresh-resume path. apps/main has already verified that
 * the calling user owns the publication (the gateway only re-checks that
 * the publication exists and is in a resumable state).
 */
app.post("/:id/form-token", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const publicationId = c.req.param("id");
  const body = await c.req.json<FormTokenBody>();
  if (!body.userId) return c.json({ error: "userId required" }, 400);

  const { slack } = buildProviders(c.env);

  let result;
  try {
    result = await slack.continueInstall({
      publicationId: null,
      payload: {
        kind: "reissue_form_token",
        publicationId,
        userId: body.userId,
        returnUrl: body.returnUrl ?? "",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "reissue_failed", details: msg }, 400);
  }

  if (result.kind !== "step" || result.step !== "credentials_form") {
    return c.json({ error: "unexpected reissue result", result }, 500);
  }
  return c.json(result.data);
});

export default app;
