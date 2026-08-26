import { Hono } from "hono";
import type { Env } from "../../env";
import { buildProviders } from "../../providers";

// Feishu publication-first install flow.
//
// Three steps, three endpoints (mirrors slack/publications.ts):
//   1. POST /feishu/publications/start
//      → INSERT feishu_publications shell (status='pending_setup'),
//        returns { formToken, publicationId, requiredFields }.
//   2. POST /feishu/publications/credentials
//      → PATCH app_id / app_secret / encrypt_key / verification_token
//        onto the publication row (encrypted via WebCryptoAesGcm), then
//        returns the returnUrl so the Console wizard can show the
//        "credentials_filled" step. (No OAuth — admins configure Feishu
//        apps directly in the developer portal.)
//   3. The WS runner (apps/main-node) flips status to 'live' once the
//        bot can talk to Feishu; there is no browser-side callback.
//
// Auth: /start is internal-only (called by apps/main via service binding)
// and requires the shared header secret. /credentials is reachable from
// the user's browser (admin handoff page submits straight here without a
// session) — auth there is the formToken JWT itself.

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

  const { feishu } = buildProviders(c.env);
  const result = await feishu.startInstall({
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
// Compatibility alias — the shared install-proxy gateway
// (packages/http-routes/src/integrations) forwards the Console's
// `feishu.startA1(...)` call to `${provider}/publications/start-a1`
// uniformly for every provider. Slack/GitHub register /start-a1; feishu
// registered only /start, so the publish-start flow 404'd end-to-end.
// Mirror the alias so the gateway path resolves. Same body, same response.
app.post("/start-a1", handleStart);

interface SubmitCredentialsBody {
  formToken: string;
  appId: string;
  appSecret: string;
  encryptKey: string;
  verificationToken: string;
}

app.post("/credentials", async (c) => {
  const body = await c.req.json<SubmitCredentialsBody>();
  if (
    !body.formToken ||
    !body.appId ||
    !body.appSecret ||
    !body.encryptKey ||
    !body.verificationToken
  ) {
    return c.json(
      {
        error: "formToken, appId, appSecret, encryptKey, verificationToken required",
        hint:
          "All four values come from the Feishu App's developer-portal page: " +
          "App ID + App Secret live on 'Credentials & Basic Info'; " +
          "Encrypt Key + Verification Token live on 'Event Subscriptions'.",
      },
      400,
    );
  }

  const { feishu } = buildProviders(c.env);

  let result;
  try {
    result = await feishu.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: body.formToken,
        appId: body.appId,
        appSecret: body.appSecret,
        encryptKey: body.encryptKey,
        verificationToken: body.verificationToken,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/JwtSigner\.verify/i.test(msg)) {
      return c.json(
        {
          error: "form_token_invalid",
          details: msg.replace(/.*JwtSigner\.verify:\s*/, ""),
          remediation: "Re-run feishu publish to mint a fresh form token (TTL ~60 min).",
        },
        400,
      );
    }
    return c.json({ error: "credentials_failed", details: msg }, 400);
  }

  // Credentials failed format validation — feishu's continueInstall returns a
  // `credentials_form` step with per-field errors (unlike slack, which throws).
  // Surface them so the Console wizard can mark the offending fields instead
  // of showing a generic 500.
  if (result.kind === "step" && result.step === "credentials_form") {
    const errors = Array.isArray(result.data.errors)
      ? (result.data.errors as Array<{ field: string; message: string }>)
      : [];
    // Use the canonical error envelope (not the legacy `{error: "<string>"}`)
    // so the `errors[]` survives main's errorEnvelopeMiddleware when proxied
    // through the gateway: its legacy branch keeps only `details` and drops
    // everything else, while the already-canonical branch spreads `...body`
    // and preserves `errors[]` + `hint`. Without this the Console would
    // receive only the bare code "credentials_invalid".
    return c.json(
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "credentials_invalid",
        },
        errors,
        hint:
          "All four values come from the Feishu App's developer-portal page: " +
          "App ID + App Secret live on 'Credentials & Basic Info'; " +
          "Encrypt Key + Verification Token live on 'Event Subscriptions'.",
      },
      400,
    );
  }

  if (result.kind !== "step" || result.step !== "install_link") {
    return c.json({ error: "unexpected continue result", result }, 500);
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
 * POST /feishu/publications/:id/form-token
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

  const { feishu } = buildProviders(c.env);

  let result;
  try {
    result = await feishu.continueInstall({
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