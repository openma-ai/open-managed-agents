import { describe, it, expect, beforeEach } from "vitest";
import { LinearProvider } from "../../packages/linear/src/provider";
import {
  buildFakeContainer,
  type FakeContainer,
} from "../../packages/integrations-core/src/test-fakes";
import { ALL_CAPABILITIES, DEFAULT_LINEAR_SCOPES } from "../../packages/linear/src/config";

function makeProvider(c: FakeContainer): LinearProvider {
  return new LinearProvider(c, {
    gatewayOrigin: "https://gw",
    scopes: DEFAULT_LINEAR_SCOPES,
    defaultCapabilities: ALL_CAPABILITIES,
  });
}

describe("LinearProvider — publication-first install (OAuth)", () => {
  let c: FakeContainer;
  let provider: LinearProvider;

  beforeEach(() => {
    c = buildFakeContainer();
    provider = makeProvider(c);
    c.tenants.set("usr_a", "tnt_acme");
  });

  // ─── Step 1: startPublication ────────────────────────────────────────

  it("startPublication writes a pending_setup row and returns final URLs", async () => {
    const result = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: "https://avatar/c.png" },
      returnUrl: "https://console/done",
    });

    expect(result.publicationId).toBeTruthy();
    expect(result.callbackUrl).toBe(
      `https://gw/linear/oauth/pub/${result.publicationId}/callback`,
    );
    expect(result.webhookUrl).toBe(
      `https://gw/linear/webhook/pub/${result.publicationId}`,
    );
    expect(result.suggestedAppName).toBe("Coder");
    expect(result.suggestedAvatarUrl).toBe("https://avatar/c.png");
    expect(result.returnUrl).toBe("https://console/done");

    // Pub row exists, status pending_setup, agent + env baked in.
    const pub = await c.publications.get(result.publicationId);
    expect(pub).toBeTruthy();
    expect(pub!.status).toBe("pending_setup");
    expect(pub!.agentId).toBe("agt_coder");
    expect(pub!.environmentId).toBe("env_dev");
    expect(pub!.tenantId).toBe("tnt_acme");
    // No installation yet — the callback will create one.
    expect(pub!.installationId).toBe("");
    // No App row was inserted — credentials live on the pub row in the
    // publication-first flow.
    expect(c.installations.listByUser("usr_a", "linear")).resolves.toHaveLength(0);
  });

  it("startPublication rejects missing required fields", async () => {
    await expect(
      provider.startPublication({
        userId: "",
        agentId: "agt_a",
        environmentId: "env_a",
        persona: { name: "n", avatarUrl: null },
        returnUrl: "https://r",
      }),
    ).rejects.toThrow(/userId/);
    await expect(
      provider.startPublication({
        userId: "usr_a",
        agentId: "",
        environmentId: "env_a",
        persona: { name: "n", avatarUrl: null },
        returnUrl: "https://r",
      }),
    ).rejects.toThrow(/agentId/);
    await expect(
      provider.startPublication({
        userId: "usr_a",
        agentId: "agt_a",
        environmentId: "",
        persona: { name: "n", avatarUrl: null },
        returnUrl: "https://r",
      }),
    ).rejects.toThrow(/environmentId/);
  });

  // ─── Step 2: submitCredentials ───────────────────────────────────────

  it("submitCredentials encrypts secrets onto the pub row and returns OAuth URL", async () => {
    const start = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });

    const submit = await provider.submitCredentials({
      publicationId: start.publicationId,
      clientId: "user_app_id",
      clientSecret: "user_app_secret",
      webhookSecret: "lin_wh_test",
      returnUrl: "https://console/done",
    });

    expect(submit.publicationId).toBe(start.publicationId);
    expect(submit.callbackUrl).toBe(start.callbackUrl);
    expect(submit.webhookUrl).toBe(start.webhookUrl);

    const installUrl = new URL(submit.installUrl);
    expect(installUrl.origin + installUrl.pathname).toBe(
      "https://linear.app/oauth/authorize",
    );
    expect(installUrl.searchParams.get("client_id")).toBe("user_app_id");
    expect(installUrl.searchParams.get("redirect_uri")).toBe(start.callbackUrl);
    expect(installUrl.searchParams.get("actor")).toBe("app");
    expect(installUrl.searchParams.get("state")).toBeTruthy();

    // Pub status flipped to awaiting_install
    const pub = await c.publications.get(start.publicationId);
    expect(pub!.status).toBe("awaiting_install");

    // Credentials persisted (decrypted via fake crypto round-trip)
    const creds = await c.publications.getCredentials(start.publicationId);
    expect(creds).toEqual({
      clientId: "user_app_id",
      clientSecret: "user_app_secret",
      webhookSecret: "lin_wh_test",
      signingSecret: null,
    });
  });

  it("submitCredentials is idempotent on retry — re-paste overwrites secrets", async () => {
    const start = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });

    await provider.submitCredentials({
      publicationId: start.publicationId,
      clientId: "first_id",
      clientSecret: "first_secret",
      webhookSecret: "lin_wh_first",
      returnUrl: "https://console/done",
    });
    // User typo'd the secret — paste again.
    await provider.submitCredentials({
      publicationId: start.publicationId,
      clientId: "second_id",
      clientSecret: "second_secret",
      webhookSecret: "lin_wh_second",
      returnUrl: "https://console/done",
    });

    const creds = await c.publications.getCredentials(start.publicationId);
    expect(creds!.clientId).toBe("second_id");
    expect(creds!.clientSecret).toBe("second_secret");
    expect(creds!.webhookSecret).toBe("lin_wh_second");
  });

  it("submitCredentials rejects unknown publicationId", async () => {
    await expect(
      provider.submitCredentials({
        publicationId: "pub_does_not_exist",
        clientId: "cid",
        clientSecret: "csec",
        webhookSecret: "wh",
        returnUrl: "https://r",
      }),
    ).rejects.toThrow(/unknown publicationId/);
  });

  it("submitCredentials rejects publications that are already live", async () => {
    const start = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    await c.publications.updateStatus(start.publicationId, "live");
    await expect(
      provider.submitCredentials({
        publicationId: start.publicationId,
        clientId: "cid",
        clientSecret: "csec",
        webhookSecret: "wh",
        returnUrl: "https://r",
      }),
    ).rejects.toThrow(/already live/);
  });

  // ─── Step 3: handleOAuthCallback ─────────────────────────────────────

  it("handleOAuthCallback exchanges code, creates installation+vault, binds pub", async () => {
    const start = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: "https://avatar/c.png" },
      returnUrl: "https://console/done",
    });
    const submit = await provider.submitCredentials({
      publicationId: start.publicationId,
      clientId: "user_app_id",
      clientSecret: "user_app_secret",
      webhookSecret: "lin_wh_test",
      returnUrl: "https://console/done",
    });
    const state = new URL(submit.installUrl).searchParams.get("state")!;

    // Simulate Linear redirecting back with code.
    c.http.respondWith(
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          access_token: "lin_at_pf",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read,write,app:assignable,app:mentionable",
          refresh_token: "lin_rt_pf",
        }),
      },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: {
            viewer: { id: "linbot_pf", name: "Coder" },
            organization: { id: "org_acme", name: "Acme", urlKey: "acme" },
          },
        }),
      },
    );

    const result = await provider.handleOAuthCallback({
      publicationId: start.publicationId,
      code: "AUTH_CODE",
      state,
    });
    expect(result.kind).toBe("complete");
    expect(result.publicationId).toBe(start.publicationId);
    expect(result.returnUrl).toBe("https://console/done");

    // Publication row: live + installation_id bound.
    const pub = await c.publications.get(start.publicationId);
    expect(pub!.status).toBe("live");
    expect(pub!.installationId).toBeTruthy();
    expect(pub!.installationId).not.toBe("");

    // Installation row: matches workspace, scopes parsed, bot_user_id set.
    const installs = await c.installations.listByUser("usr_a", "linear");
    expect(installs).toHaveLength(1);
    expect(installs[0].installKind).toBe("dedicated");
    expect(installs[0].workspaceId).toBe("org_acme");
    expect(installs[0].botUserId).toBe("linbot_pf");
    // appId is null in the publication-first flow — credentials live on the
    // publication row, not in linear_apps.
    expect(installs[0].appId).toBeNull();
    expect(installs[0].vaultId).toBeTruthy();

    // Vault credential created for outbound injection
    expect(c.vaults.created).toHaveLength(1);
    expect(c.vaults.created[0].mcpServerUrl).toBe("https://mcp.linear.app/mcp");
    expect(c.vaults.created[0].bearerToken).toBe("lin_at_pf");
  });

  it("handleOAuthCallback rejects mismatched publicationId in state", async () => {
    const start = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    const submit = await provider.submitCredentials({
      publicationId: start.publicationId,
      clientId: "cid",
      clientSecret: "csec",
      webhookSecret: "lin_wh_test",
      returnUrl: "https://console/done",
    });
    const state = new URL(submit.installUrl).searchParams.get("state")!;

    await expect(
      provider.handleOAuthCallback({
        publicationId: "pub_wrong",
        code: "C",
        state,
      }),
    ).rejects.toThrow(/state\.publicationId mismatch|unknown publicationId/);
  });

  it("handleOAuthCallback rejects pubs without credentials", async () => {
    const start = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    // Mint a state JWT manually for pending_setup pub
    const state = await c.jwt.sign(
      {
        kind: "linear.oauth.publication",
        publicationId: start.publicationId,
        returnUrl: "https://console/done",
        nonce: "n",
      },
      300,
    );
    await expect(
      provider.handleOAuthCallback({
        publicationId: start.publicationId,
        code: "C",
        state,
      }),
    ).rejects.toThrow(/no credentials/);
  });

  it("handleOAuthCallback rejects token-exchange failures", async () => {
    const start = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    const submit = await provider.submitCredentials({
      publicationId: start.publicationId,
      clientId: "cid",
      clientSecret: "csec",
      webhookSecret: "lin_wh_test",
      returnUrl: "https://console/done",
    });
    const state = new URL(submit.installUrl).searchParams.get("state")!;

    c.http.respondWith({
      status: 401,
      headers: {},
      body: JSON.stringify({ error: "invalid_client" }),
    });

    await expect(
      provider.handleOAuthCallback({
        publicationId: start.publicationId,
        code: "AUTH_CODE",
        state,
      }),
    ).rejects.toThrow(/Linear OAuth token exchange failed: 401/);

    // Pub stayed at awaiting_install — no half-bound state on disk.
    const pub = await c.publications.get(start.publicationId);
    expect(pub!.status).toBe("awaiting_install");
    expect(pub!.installationId).toBe("");
    expect(c.vaults.created).toHaveLength(0);
  });

  it("handleOAuthCallback double-click is idempotent — second call returns existing pub", async () => {
    const start = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    const submit = await provider.submitCredentials({
      publicationId: start.publicationId,
      clientId: "cid",
      clientSecret: "csec",
      webhookSecret: "lin_wh_test",
      returnUrl: "https://console/done",
    });
    const state = new URL(submit.installUrl).searchParams.get("state")!;

    c.http.respondWith(
      {
        status: 200,
        headers: {},
        body: JSON.stringify({ access_token: "tok", token_type: "Bearer", expires_in: 3600, scope: "read", refresh_token: "rt" }),
      },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: {
            viewer: { id: "u", name: "u" },
            organization: { id: "ws", name: "WS", urlKey: "ws" },
          },
        }),
      },
    );

    const first = await provider.handleOAuthCallback({
      publicationId: start.publicationId,
      code: "C",
      state,
    });
    expect(first.kind).toBe("complete");

    // Second call — pub is now live; no second installation should be inserted.
    const installsBefore = await c.installations.listByUser("usr_a", "linear");
    const second = await provider.handleOAuthCallback({
      publicationId: start.publicationId,
      code: "C",
      state,
    });
    const installsAfter = await c.installations.listByUser("usr_a", "linear");
    expect(second.publicationId).toBe(first.publicationId);
    expect(installsAfter).toHaveLength(installsBefore.length);
  });

  it("handleOAuthCallback rejects when workspace already has an active dedicated install", async () => {
    // Pre-existing live install for the same workspace.
    await c.installations.insert({
      tenantId: "tnt_acme",
      userId: "usr_a",
      providerId: "linear",
      workspaceId: "org_acme",
      workspaceName: "Acme",
      installKind: "dedicated",
      appId: null,
      accessToken: "old_tok",
      refreshToken: null,
      scopes: ["read"],
      botUserId: "old_bot",
    });

    const start = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    const submit = await provider.submitCredentials({
      publicationId: start.publicationId,
      clientId: "cid",
      clientSecret: "csec",
      webhookSecret: "lin_wh_test",
      returnUrl: "https://console/done",
    });
    const state = new URL(submit.installUrl).searchParams.get("state")!;

    c.http.respondWith(
      {
        status: 200,
        headers: {},
        body: JSON.stringify({ access_token: "tok", token_type: "Bearer", expires_in: 3600, scope: "read", refresh_token: "rt" }),
      },
      {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: {
            viewer: { id: "u", name: "u" },
            organization: { id: "org_acme", name: "Acme", urlKey: "acme" },
          },
        }),
      },
    );

    await expect(
      provider.handleOAuthCallback({
        publicationId: start.publicationId,
        code: "C",
        state,
      }),
    ).rejects.toThrow(/already has an active dedicated install/);
  });
});
