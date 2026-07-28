import { Hono } from "hono";
import type { Env } from "../../env";
import { buildProviders } from "../../providers";

// Linear install entry points (publication-first).
//
// Three endpoints, each touching exactly one anchor row:
//
//   1. POST /linear/publications
//        body: { userId, agentId, environmentId, personaName, ... }
//        → insertShell (status='pending_setup'); returns publication_id +
//          callback/webhook URLs the user pastes into Linear.
//
//   2. PATCH /linear/publications/:id/credentials
//        body: { clientId, clientSecret, webhookSecret, signingSecret? }
//        → setCredentials (status='awaiting_install'); returns OAuth URL
//          the user clicks.
//
//   3. POST /linear/publications/personal-token
//        body: { agentId, environmentId, ..., patToken }
//        → atomic PAT install (no OAuth dance). Status='live' on return.
//
// /publications and /personal-token are internal-only (called by apps/main
// via service binding) and require the shared header secret. /credentials
// is reachable directly from the user's browser (admin handoff page can
// submit straight here without a session) — auth there is the publication
// id itself; the underlying flow re-grants OAuth consent on Linear's side
// before any token issues are minted.

const app = new Hono<{ Bindings: Env }>();

function requireInternalSecret(env: Env, headerValue: string | undefined): boolean {
  return Boolean(
    env.INTEGRATIONS_INTERNAL_SECRET &&
      headerValue === env.INTEGRATIONS_INTERNAL_SECRET,
  );
}

interface CreatePublicationBody {
  userId: string;
  agentId: string;
  environmentId: string;
  personaName: string;
  personaAvatarUrl: string | null;
  returnUrl: string;
}

app.post("/", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json<CreatePublicationBody>();
  if (
    !body.userId ||
    !body.agentId ||
    !body.environmentId ||
    !body.personaName ||
    !body.returnUrl
  ) {
    return c.json(
      { error: "userId, agentId, environmentId, personaName, returnUrl required" },
      400,
    );
  }

  const { linear } = buildProviders(c.env);
  try {
    const result = await linear.startPublication({
      userId: body.userId,
      agentId: body.agentId,
      environmentId: body.environmentId,
      persona: { name: body.personaName, avatarUrl: body.personaAvatarUrl },
      returnUrl: body.returnUrl,
    });
    return c.json({
      publication_id: result.publicationId,
      callback_url: result.callbackUrl,
      webhook_url: result.webhookUrl,
      suggested_app_name: result.suggestedAppName,
      suggested_avatar_url: result.suggestedAvatarUrl,
      return_url: result.returnUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "create_publication_failed", details: msg }, 400);
  }
});

interface SubmitCredentialsBody {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  signingSecret?: string | null;
  /** Where to redirect after OAuth completes. Carried through the state
   *  JWT so the callback can build a final 302 target without a cookie. */
  returnUrl: string;
}

app.patch("/:id/credentials", async (c) => {
  const publicationId = c.req.param("id");
  const body = await c.req.json<SubmitCredentialsBody>();
  if (!body.clientId || !body.clientSecret || !body.webhookSecret) {
    return c.json(
      {
        error: "clientId, clientSecret, webhookSecret required",
        hint:
          "webhookSecret comes from the Linear App's webhook page (the 'lin_wh_…' value). " +
          "Linear auto-generates it; OMA can't predict it.",
      },
      400,
    );
  }
  if (!body.returnUrl) {
    return c.json({ error: "returnUrl required" }, 400);
  }

  const { linear } = buildProviders(c.env);
  try {
    const result = await linear.submitCredentials({
      publicationId,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      webhookSecret: body.webhookSecret,
      signingSecret: body.signingSecret ?? null,
      returnUrl: body.returnUrl,
    });
    return c.json({
      install_url: result.installUrl,
      publication_id: result.publicationId,
      callback_url: result.callbackUrl,
      webhook_url: result.webhookUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "credentials_failed", details: msg }, 400);
  }
});

interface PersonalTokenBody {
  userId: string;
  agentId: string;
  environmentId: string;
  personaName: string;
  personaAvatarUrl: string | null;
  patToken: string;
}

/**
 * One-shot install for the PAT path. The user pasted a Linear Personal API
 * Key — we validate it via viewer query, persist installation+publication
 * atomically, and return the publicationId so Console can navigate. No
 * OAuth, no callback page, no wait_for_webhook step.
 *
 * Internal-only: apps/main proxies via service binding after authenticating
 * the user.
 */
app.post("/personal-token", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json<PersonalTokenBody>();
  if (
    !body.userId ||
    !body.agentId ||
    !body.environmentId ||
    !body.personaName ||
    !body.patToken
  ) {
    return c.json(
      {
        error:
          "userId, agentId, environmentId, personaName, patToken required",
      },
      400,
    );
  }

  const { linear } = buildProviders(c.env);

  try {
    const result = await linear.installPersonalToken({
      userId: body.userId,
      agentId: body.agentId,
      environmentId: body.environmentId,
      persona: { name: body.personaName, avatarUrl: body.personaAvatarUrl },
      patToken: body.patToken,
    });
    return c.json({ publicationId: result.publicationId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "pat_install_failed", details: msg }, 400);
  }
});

interface FormTokenBody {
  /** Forwarded from apps/main; identifies the publication owner. */
  userId: string;
  /** Optional — defaults to "" when the wizard doesn't track returnUrl. */
  returnUrl?: string;
}

/**
 * POST /linear/publications/:id/form-token
 *
 * Re-derive the publication-shell payload for an existing pub row. Linear
 * doesn't use a formToken (its wizard keys directly off the publicationId),
 * so the response shape mirrors `startPublication` — the wizard's existing
 * step-1 render path handles it transparently.
 */
app.post("/:id/form-token", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const publicationId = c.req.param("id");
  const body = await c.req.json<FormTokenBody>();
  if (!body.userId) return c.json({ error: "userId required" }, 400);

  const { linear } = buildProviders(c.env);

  try {
    const result = await linear.resumePublication({
      publicationId,
      userId: body.userId,
      returnUrl: body.returnUrl ?? "",
    });
    return c.json({
      publication_id: result.publicationId,
      callback_url: result.callbackUrl,
      webhook_url: result.webhookUrl,
      suggested_app_name: result.suggestedAppName,
      suggested_avatar_url: result.suggestedAvatarUrl,
      return_url: result.returnUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "reissue_failed", details: msg }, 400);
  }
});

export default app;
