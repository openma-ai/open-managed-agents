import { describe, it, expect, beforeEach } from "vitest";
import { SlackProvider } from "../../packages/slack/src/provider";
import {
  buildFakeSlackContainer,
  makeSlackProvider,
  tokenResponseBody,
  type FakeSlackBundle,
} from "./slack-test-helpers";

describe("SlackProvider — publication-first install flow", () => {
  let c: FakeSlackBundle;
  let provider: SlackProvider;

  beforeEach(() => {
    c = buildFakeSlackContainer();
    provider = makeSlackProvider(c);
  });

  it("startInstall creates a shell publication and returns the pub-keyed callback URL", async () => {
    const result = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: "https://avatar/c.png" },
      returnUrl: "https://console/done",
    });
    expect(result.kind).toBe("step");
    if (result.kind !== "step") return;
    expect(result.step).toBe("credentials_form");
    expect(result.data.formToken).toBeTruthy();
    expect(result.data.suggestedAppName).toBe("Coder");
    expect(result.data.publicationId).toBeTruthy();
    const pubId = result.data.publicationId as string;
    expect(result.data.callbackUrl as string).toBe(
      `https://gw/slack/oauth/pub/${pubId}/callback`,
    );
    expect(result.data.webhookUrl as string).toBe(
      `https://gw/slack/webhook/pub/${pubId}`,
    );
    // Manifest launch URL is pre-baked with the pub-keyed redirect URL.
    const manifestUrl = result.data.manifestLaunchUrl as string;
    expect(manifestUrl).toMatch(/^https:\/\/api\.slack\.com\/apps\?/);
    const parsedManifest = new URL(manifestUrl);
    expect(parsedManifest.searchParams.get("new_app")).toBe("1");
    const manifest = JSON.parse(parsedManifest.searchParams.get("manifest_json") ?? "");
    expect(manifest.display_information.name).toBe("Coder");
    expect(manifest.oauth_config.redirect_urls[0]).toBe(result.data.callbackUrl);

    // The publication row exists with status='pending_setup' and the
    // agent/env/persona we passed in. installation_id is "" — sentinel until
    // OAuth completes.
    const pub = await c.publications.get(pubId);
    expect(pub).toBeTruthy();
    expect(pub?.status).toBe("pending_setup");
    expect(pub?.agentId).toBe("agt_coder");
    expect(pub?.environmentId).toBe("env_dev");
    expect(pub?.installationId).toBe("");
  });

  it("submit_credentials encrypts secrets onto the publication and returns OAuth URL", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const formToken = start.data.formToken as string;
    const pubId = start.data.publicationId as string;

    const submit = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken,
        clientId: "user_app_id",
        clientSecret: "user_app_secret",
        signingSecret: "slack_signing_secret",
      },
    });
    if (submit.kind !== "step") throw new Error("expected step");
    expect(submit.step).toBe("install_link");
    expect(submit.data.publicationId).toBe(pubId);

    const installUrl = new URL(submit.data.url as string);
    expect(installUrl.origin + installUrl.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(installUrl.searchParams.get("client_id")).toBe("user_app_id");
    expect(installUrl.searchParams.get("scope")).toContain("app_mentions:read");
    expect(installUrl.searchParams.get("user_scope")).toContain("search:read.public");

    // Credentials are now staged on the publication row.
    const state = await c.publications.getCredentialState(pubId);
    expect(state?.clientId).toBe("user_app_id");
    expect(state?.hasClientSecret).toBe(true);
    expect(state?.hasSigningSecret).toBe(true);
    // And decryptable.
    expect(await c.publications.getClientSecret(pubId)).toBe("user_app_secret");
    expect(await c.publications.getSigningSecret(pubId)).toBe("slack_signing_secret");

    // Status moved off pending_setup.
    const pub = await c.publications.get(pubId);
    expect(pub?.status).toBe("awaiting_install");
  });

  it("re-paste credentials is idempotent at the publication level (no ghost rows)", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const formToken = start.data.formToken as string;
    const pubId = start.data.publicationId as string;

    // First paste — typo in the signing secret.
    await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken,
        clientId: "cid",
        clientSecret: "csec",
        signingSecret: "wrong_signing_secret",
      },
    });
    expect(await c.publications.getSigningSecret(pubId)).toBe("wrong_signing_secret");

    // Re-paste with the correct secret. Same publication row, no new shell.
    await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken,
        clientId: "cid",
        clientSecret: "csec",
        signingSecret: "correct_signing_secret",
      },
    });
    expect(await c.publications.getSigningSecret(pubId)).toBe("correct_signing_secret");

    // Still exactly one publication for this (user, agent).
    const pubs = await c.publications.listByUserAndAgent("usr_a", "agt_coder");
    expect(pubs).toHaveLength(1);
    expect(pubs[0].id).toBe(pubId);
  });

  it("OAuth callback completes install, stores both tokens, creates two vaults, binds installation back to publication", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: "https://avatar/c.png" },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const submit = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: start.data.formToken as string,
        clientId: "user_app_id",
        clientSecret: "user_app_secret",
        signingSecret: "slack_signing_secret",
      },
    });
    if (submit.kind !== "step") throw new Error("expected step");
    const installUrl = new URL(submit.data.url as string);
    const state = installUrl.searchParams.get("state")!;
    const pubId = submit.data.publicationId as string;

    // Slack will respond with: oauth.v2.access (token), then auth.test (sanity check).
    c.http.respondWith(
      {
        status: 200,
        headers: {},
        body: tokenResponseBody(),
      },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          ok: true,
          url: "https://acme.slack.com/",
          team: "Acme",
          user: "coder",
          team_id: "T07TEAM",
          user_id: "U07USER",
          bot_id: "B07BOT",
        }),
      },
    );

    const complete = await provider.continueInstall({
      publicationId: null,
      payload: { kind: "oauth_callback_pub", publicationId: pubId, code: "AUTH_CODE", state },
    });
    expect(complete.kind).toBe("complete");
    if (complete.kind !== "complete") return;
    expect(complete.publicationId).toBe(pubId);

    const pub = await c.publications.get(pubId);
    expect(pub).toBeTruthy();
    expect(pub?.status).toBe("live");
    expect(pub?.mode).toBe("full");
    expect(pub?.sessionGranularity).toBe("per_channel");
    expect(pub?.installationId).toBeTruthy();
    expect(pub?.installationId).not.toBe("");

    const installs = await c.installations.listByUser("usr_a", "slack");
    expect(installs).toHaveLength(1);
    expect(installs[0].installKind).toBe("dedicated");
    expect(installs[0].appId).toBe("A07APP");
    expect(installs[0].workspaceId).toBe("T07TEAM");
    expect(installs[0].workspaceName).toBe("Acme");
    expect(installs[0].id).toBe(pub?.installationId);

    // User token stashed via the Slack-only setUserToken extension.
    const userToken = await c.installations.getUserToken(installs[0].id);
    expect(userToken).toBe("xoxp-user-test");

    // App row exists, keyed on Slack's app_id, with the publication bound.
    const app = await c.apps.get("A07APP");
    expect(app?.publicationId).toBe(complete.publicationId);

    // Publication knows its Slack-side app id (so webhook receivers can
    // resolve by app_id without going through slack_apps).
    const credState = await c.publications.getCredentialState(pubId);
    expect(credState?.slackAppId).toBe("A07APP");

    // And we can find the publication by Slack-app-id from the webhook
    // side (this is the lookup path).
    const found = await c.publications.findBySlackAppId("A07APP");
    expect(found?.id).toBe(pubId);

    // TWO vaults — one for mcp.slack.com (user xoxp-) + one for slack.com/api (bot xoxb-).
    expect(c.vaults.created).toHaveLength(2);
    const mcpVault = c.vaults.created.find((v) => v.mcpServerUrl === "https://mcp.slack.com/mcp");
    const apiVault = c.vaults.created.find((v) => v.mcpServerUrl === "https://slack.com/api");
    expect(mcpVault).toBeTruthy();
    expect(mcpVault?.bearerToken).toBe("xoxp-user-test");
    expect(apiVault).toBeTruthy();
    expect(apiVault?.bearerToken).toBe("xoxb-bot-test");

    // Both vault ids stored on the installation.
    const inst = await c.installations.get(installs[0].id);
    expect(inst?.vaultId).toBeTruthy(); // primary (xoxp-)
    expect(await c.installations.getBotVaultId(installs[0].id)).toBeTruthy(); // bot (xoxb-)
  });

  it("rejects callback with mismatched publicationId in state", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const submit = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: start.data.formToken as string,
        clientId: "cid",
        clientSecret: "csec",
        signingSecret: "ssec",
      },
    });
    if (submit.kind !== "step") throw new Error("expected step");
    const state = new URL(submit.data.url as string).searchParams.get("state")!;

    await expect(
      provider.continueInstall({
        publicationId: null,
        payload: {
          kind: "oauth_callback_pub",
          publicationId: "pub_wrong",
          code: "C",
          state,
        },
      }),
    ).rejects.toThrow(/publicationId mismatch|unknown publicationId/);
  });

  it("OAuth callback surfaces token-exchange failure clearly; publication stays resumable", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const submit = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: start.data.formToken as string,
        clientId: "cid",
        clientSecret: "csec",
        signingSecret: "ssec",
      },
    });
    if (submit.kind !== "step") throw new Error("expected step");
    const state = new URL(submit.data.url as string).searchParams.get("state")!;
    const pubId = submit.data.publicationId as string;

    // Slack returns ok=false with an error.
    c.http.respondWith({
      status: 200,
      headers: {},
      body: JSON.stringify({ ok: false, error: "invalid_code" }),
    });

    await expect(
      provider.continueInstall({
        publicationId: null,
        payload: { kind: "oauth_callback_pub", publicationId: pubId, code: "BAD", state },
      }),
    ).rejects.toThrow(/token exchange failed|invalid_code/);

    // Publication is still resumable — status stayed at awaiting_install,
    // no installation got materialized, no ghost row to clean up.
    const pub = await c.publications.get(pubId);
    expect(pub?.status).toBe("awaiting_install");
    expect(pub?.installationId).toBe("");
    const installs = await c.installations.listByUser("usr_a", "slack");
    expect(installs).toHaveLength(0);
  });

  it("OAuth callback is idempotent — second arrival with the same publication-id is a no-op", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const submit = await provider.continueInstall({
      publicationId: null,
      payload: {
        kind: "submit_credentials",
        formToken: start.data.formToken as string,
        clientId: "cid",
        clientSecret: "csec",
        signingSecret: "ssec",
      },
    });
    if (submit.kind !== "step") throw new Error("expected step");
    const state = new URL(submit.data.url as string).searchParams.get("state")!;
    const pubId = submit.data.publicationId as string;

    c.http.respondWith(
      { status: 200, headers: {}, body: tokenResponseBody() },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({ ok: true, url: "https://acme.slack.com/", team: "Acme", team_id: "T07TEAM", user_id: "U07USER", bot_id: "B07BOT" }),
      },
    );

    const first = await provider.continueInstall({
      publicationId: null,
      payload: { kind: "oauth_callback_pub", publicationId: pubId, code: "AUTH_CODE", state },
    });
    expect(first.kind).toBe("complete");

    // A second callback with the same publication id (e.g. user double-clicked,
    // Slack retried) should short-circuit. No new install, no new vaults, no
    // attempt to re-exchange the (now spent) code.
    const second = await provider.continueInstall({
      publicationId: null,
      payload: { kind: "oauth_callback_pub", publicationId: pubId, code: "AUTH_CODE", state },
    });
    expect(second.kind).toBe("complete");
    if (second.kind !== "complete") return;
    expect(second.publicationId).toBe(pubId);

    // Still exactly one installation and two vaults.
    const installs = await c.installations.listByUser("usr_a", "slack");
    expect(installs).toHaveLength(1);
    expect(c.vaults.created).toHaveLength(2);
  });

  it("handoff_link re-signs the formToken into a 7-day shareable URL", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");

    const handoff = await provider.continueInstall({
      publicationId: null,
      payload: { kind: "handoff_link", formToken: start.data.formToken as string },
    });
    if (handoff.kind !== "step") throw new Error("expected step");
    expect(handoff.step).toBe("install_link");
    expect(handoff.data.url as string).toMatch(/^https:\/\/gw\/slack-setup\//);
    expect(handoff.data.expiresInDays).toBe(7);
  });
});
