import { describe, it, expect, beforeEach } from "vitest";
import { LinearProvider } from "../../packages/linear/src/provider";
import {
  buildFakeContainer,
  type FakeContainer,
} from "../../packages/integrations-core/src/test-fakes";
import { ALL_CAPABILITIES, DEFAULT_LINEAR_SCOPES } from "../../packages/linear/src/config";

const WEBHOOK_SECRET = "wsec";

function makeProvider(c: FakeContainer): LinearProvider {
  return new LinearProvider(c, {
    gatewayOrigin: "https://gw",
    scopes: DEFAULT_LINEAR_SCOPES,
    defaultCapabilities: ALL_CAPABILITIES,
  });
}

/**
 * Seed a live publication-first install: pub shell + credentials +
 * installation + bindInstallation. Returns the pub_id (URL key) and
 * inst_id for assertions. Webhook URL routing is keyed on pub_id, so
 * tests pass it as `installationId` on WebhookRequest (the field name is
 * a hold-over from legacy app-id keying — see WebhookRequest in
 * integrations-core).
 */
async function seedLivePublication(
  c: FakeContainer,
): Promise<{ instId: string; pubId: string }> {
  c.tenants.set("usr_a", "tnt_acme");
  // Publication shell + credentials
  const pubShell = await c.publications.insertShell({
    tenantId: "tnt_acme",
    userId: "usr_a",
    agentId: "agt_default",
    environmentId: "env_dev",
    mode: "full",
    persona: { name: "Triage", avatarUrl: null },
    capabilities: new Set(),
    sessionGranularity: "per_issue",
  });
  await c.publications.setCredentials(pubShell.id, {
    clientId: "cid",
    clientSecret: "csec",
    webhookSecret: WEBHOOK_SECRET,
  });

  // Installation (created by handleOAuthCallback in real flow).
  const inst = await c.installations.insert({
    tenantId: "tnt_acme",
    userId: "usr_a",
    providerId: "linear",
    workspaceId: "org_acme",
    workspaceName: "Acme",
    installKind: "dedicated",
    appId: null,
    accessToken: "lin_at",
    refreshToken: null,
    scopes: ["read", "write"],
    botUserId: "linbot",
  });
  await c.installations.setVaultId(inst.id, "vlt_acme");

  // Bind: installation_id + status='live' onto the pub row.
  await c.publications.bindInstallation(pubShell.id, {
    installationId: inst.id,
    vaultId: "vlt_acme",
  });

  return { instId: inst.id, pubId: pubShell.id };
}

const ASSIGN_PAYLOAD = JSON.stringify({
  type: "AppUserNotification",
  action: "issueAssignedToYou",
  webhookId: "del_xyz",
  organizationId: "org_acme",
  notification: {
    type: "issueAssignedToYou",
    issue: {
      id: "iss_142",
      identifier: "ENG-142",
      title: "Auth bug",
      labels: { nodes: [] },
    },
    actor: { id: "usr_alice", name: "Alice" },
  },
});

describe("LinearProvider — handleWebhook (publication-first)", () => {
  let c: FakeContainer;
  let provider: LinearProvider;
  let instId: string;
  let pubId: string;

  beforeEach(async () => {
    c = buildFakeContainer();
    provider = makeProvider(c);
    const seeded = await seedLivePublication(c);
    instId = seeded.instId;
    pubId = seeded.pubId;
  });

  it("rejects unsigned (no signature header)", async () => {
    const out = await provider.handleWebhook({
      providerId: "linear",
      // Webhook URL key in publication-first flow is the publication_id;
      // the WebhookRequest.installationId field carries it for transport
      // (the field name is legacy).
      installationId: pubId,
      deliveryId: "del_1",
      headers: {},
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out).toEqual({ handled: false, reason: "missing_signature" });
  });

  it("rejects bad signature", async () => {
    const out = await provider.handleWebhook({
      providerId: "linear",
      installationId: pubId,
      deliveryId: "del_1",
      headers: { "linear-signature": "bogus" },
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out).toEqual({ handled: false, reason: "invalid_signature" });
  });

  it("rejects when publication is missing", async () => {
    const out = await provider.handleWebhook({
      providerId: "linear",
      installationId: "pub_does_not_exist",
      deliveryId: "del_1",
      headers: { "linear-signature": `expected:${WEBHOOK_SECRET}:${ASSIGN_PAYLOAD}` },
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out.handled).toBe(false);
    expect(out.reason).toMatch(/publication_not_found/);
  });

  it("rejects when publication is unpublished", async () => {
    await c.publications.markUnpublished(pubId, c.clock.nowMs());
    const out = await provider.handleWebhook({
      providerId: "linear",
      installationId: pubId,
      deliveryId: "del_1",
      headers: { "linear-signature": `expected:${WEBHOOK_SECRET}:${ASSIGN_PAYLOAD}` },
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out.handled).toBe(false);
    expect(out.reason).toBe("publication_unpublished");
  });

  it("dedupes duplicate delivery_id", async () => {
    const out1 = await provider.handleWebhook({
      providerId: "linear",
      installationId: pubId,
      deliveryId: "del_dup",
      headers: { "linear-signature": `expected:${WEBHOOK_SECRET}:${ASSIGN_PAYLOAD}` },
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out1.handled).toBe(true);

    const out2 = await provider.handleWebhook({
      providerId: "linear",
      installationId: pubId,
      deliveryId: "del_dup",
      headers: { "linear-signature": `expected:${WEBHOOK_SECRET}:${ASSIGN_PAYLOAD}` },
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out2).toEqual({ handled: false, reason: "duplicate_delivery" });

    // Async architecture: handleWebhook promotes to actionable in
    // linear_events; sessions.create is invoked by drainPendingEvents in
    // the cron tick. Assert dedup at the queue level.
    const queued = await c.webhookEvents.listUnprocessed(10);
    expect(queued).toHaveLength(1);
  });

  it("references the bound installation tenantId on actionable webhooks", async () => {
    const out = await provider.handleWebhook({
      providerId: "linear",
      installationId: pubId,
      deliveryId: "del_t",
      headers: { "linear-signature": `expected:${WEBHOOK_SECRET}:${ASSIGN_PAYLOAD}` },
      rawBody: ASSIGN_PAYLOAD,
    });
    expect(out.handled).toBe(true);
    expect(out.tenantId).toBe("tnt_acme");
    // No actual session yet — drain handles that.
    expect(c.sessions.created).toHaveLength(0);
    // instId is referenced from the seed for parity with the legacy test.
    expect(instId).toBeTruthy();
  });
});
