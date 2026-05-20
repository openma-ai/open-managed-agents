// Tests for the publication-first install resume surface:
//
//   - `reissueFormToken(publicationId, userId)` re-mints a fresh formToken
//     against an existing shell row without INSERTing a new one. Slack and
//     GitHub use this directly; Linear's analogous `resumePublication` just
//     re-derives URLs (no formToken).
//   - `listPendingByUser(userId)` filters in-progress publications
//     (pending_setup / credentials_filled / awaiting_install) and excludes
//     live / unpublished / needs_reauth rows.
//   - Ownership: providers throw when the caller's userId doesn't match
//     `publication.userId`.
//
// These shore up the wizard refresh-resume path (Console reads ?pub= from
// the URL and calls reissueFormToken/getPublication on mount). Without
// them, refresh would lose the formToken JWT and the user couldn't proceed.

import { describe, it, expect, beforeEach } from "vitest";

import { SlackProvider } from "../../packages/slack/src/provider";
import { GitHubProvider } from "../../packages/github/src/provider";
import { LinearProvider } from "../../packages/linear/src/provider";

import {
  buildFakeSlackContainer,
  makeSlackProvider,
  type FakeSlackBundle,
} from "./slack-test-helpers";
import {
  buildFakeGitHubContainer,
  type FakeGitHubContainer,
} from "../../packages/github/src/test-fakes";
import {
  buildFakeContainer,
  type FakeContainer,
} from "../../packages/integrations-core/src/test-fakes";
import {
  ALL_CAPABILITIES,
  DEFAULT_LINEAR_SCOPES,
} from "../../packages/linear/src/config";
import {
  DEFAULT_GITHUB_CAPABILITIES,
  DEFAULT_GITHUB_MCP_URL,
} from "../../packages/github/src/config";

describe("SlackProvider — refresh-resume surface", () => {
  let c: FakeSlackBundle;
  let provider: SlackProvider;

  beforeEach(() => {
    c = buildFakeSlackContainer();
    provider = makeSlackProvider(c);
  });

  it("reissueFormToken re-mints a fresh formToken for a pending shell without INSERTing", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const pubId = start.data.publicationId as string;
    const originalToken = start.data.formToken as string;

    // Reissue: same publication id, fresh formToken, same callback URLs.
    const reissued = await provider.reissueFormToken({
      publicationId: pubId,
      userId: "usr_a",
      returnUrl: "https://console/done",
    });
    if (reissued.kind !== "step") throw new Error("expected step");
    expect(reissued.step).toBe("credentials_form");
    expect(reissued.data.publicationId).toBe(pubId);
    expect(reissued.data.formToken).toBeTruthy();
    expect(reissued.data.formToken).not.toBe(originalToken);
    expect(reissued.data.callbackUrl).toBe(
      `https://gw/slack/oauth/pub/${pubId}/callback`,
    );

    // Exactly one publication for this user — reissue did NOT insert a
    // ghost row.
    const pubs = await c.publications.listByUserAndAgent("usr_a", "agt_coder");
    expect(pubs).toHaveLength(1);
    expect(pubs[0].id).toBe(pubId);
  });

  it("reissueFormToken rejects when userId does not own the publication", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const pubId = start.data.publicationId as string;

    await expect(
      provider.reissueFormToken({
        publicationId: pubId,
        userId: "usr_attacker",
        returnUrl: "https://console/done",
      }),
    ).rejects.toThrow(/owner mismatch/);
  });

  it("reissueFormToken rejects publications past awaiting_install", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const pubId = start.data.publicationId as string;

    // Force the publication into a terminal state.
    await c.publications.markUnpublished(pubId, Date.now());

    await expect(
      provider.reissueFormToken({
        publicationId: pubId,
        userId: "usr_a",
        returnUrl: "https://console/done",
      }),
    ).rejects.toThrow(/cannot resume/);
  });

  it("listPendingByUser returns shells across pending_setup / awaiting_install and excludes live / unpublished", async () => {
    // Two pending pubs for usr_a.
    await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_one",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "One", avatarUrl: null },
      returnUrl: "https://r",
    });
    const second = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_two",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Two", avatarUrl: null },
      returnUrl: "https://r",
    });
    if (second.kind !== "step") throw new Error("expected step");
    // Push second to awaiting_install via setCredentials.
    await c.publications.setCredentials(second.data.publicationId as string, {
      clientId: "cid",
      clientSecretCipher: "enc(csec)",
      signingSecretCipher: "enc(ssec)",
    });

    // One pending pub for a different user — should be excluded.
    await provider.startInstall({
      userId: "usr_other",
      agentId: "agt_other",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Other", avatarUrl: null },
      returnUrl: "https://r",
    });

    // One unpublished pub for usr_a — should be excluded.
    const unpublished = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_three",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Three", avatarUrl: null },
      returnUrl: "https://r",
    });
    if (unpublished.kind !== "step") throw new Error("expected step");
    await c.publications.markUnpublished(unpublished.data.publicationId as string, Date.now());

    const pending = await c.publications.listPendingByUser("usr_a");
    expect(pending.map((p) => p.agentId).sort()).toEqual(["agt_one", "agt_two"]);
  });
});

describe("GitHubProvider — refresh-resume surface", () => {
  let c: FakeGitHubContainer;
  let provider: GitHubProvider;

  function makeProvider(c: FakeGitHubContainer): GitHubProvider {
    return new GitHubProvider(c, {
      gatewayOrigin: "https://gw",
      defaultCapabilities: DEFAULT_GITHUB_CAPABILITIES,
      mcpServerUrl: DEFAULT_GITHUB_MCP_URL,
    });
  }

  beforeEach(() => {
    c = buildFakeGitHubContainer();
    provider = makeProvider(c);
  });

  it("reissueFormToken re-mints a fresh formToken keyed on the same app_oma_id", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://console/done",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const pubId = start.data.publicationId as string;
    const originalAppOmaId = start.data.appOmaId as string;
    const originalToken = start.data.formToken as string;

    const reissued = await provider.reissueFormToken({
      publicationId: pubId,
      userId: "usr_a",
      returnUrl: "https://console/done",
    });
    if (reissued.kind !== "step") throw new Error("expected step");
    expect(reissued.step).toBe("credentials_form");
    expect(reissued.data.publicationId).toBe(pubId);
    // app_oma_id is the stable webhook URL key — must NOT change on reissue
    // (or the user would have to update GitHub's "Webhook URL" field).
    expect(reissued.data.appOmaId).toBe(originalAppOmaId);
    expect(reissued.data.formToken).toBeTruthy();
    expect(reissued.data.formToken).not.toBe(originalToken);
    expect(reissued.data.webhookUrl).toBe(
      `https://gw/github/webhook/app/${originalAppOmaId}`,
    );
    // No second shell row.
    const pubs = await c.publications.listByUserAndAgent("usr_a", "agt_coder");
    expect(pubs).toHaveLength(1);
  });

  it("reissueFormToken rejects when userId does not own the publication", async () => {
    const start = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://r",
    });
    if (start.kind !== "step") throw new Error("expected step");
    const pubId = start.data.publicationId as string;
    await expect(
      provider.reissueFormToken({
        publicationId: pubId,
        userId: "usr_attacker",
        returnUrl: "https://r",
      }),
    ).rejects.toThrow(/owner mismatch/);
  });

  it("listPendingByUser surfaces pending GitHub pubs and excludes unpublished", async () => {
    await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_one",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "One", avatarUrl: null },
      returnUrl: "https://r",
    });
    const unpublished = await provider.startInstall({
      userId: "usr_a",
      agentId: "agt_two",
      environmentId: "env_dev",
      mode: "full",
      persona: { name: "Two", avatarUrl: null },
      returnUrl: "https://r",
    });
    if (unpublished.kind !== "step") throw new Error("expected step");
    await c.publications.markUnpublished(
      unpublished.data.publicationId as string,
      Date.now(),
    );

    const pending = await c.publications.listPendingByUser("usr_a");
    expect(pending.map((p) => p.agentId)).toEqual(["agt_one"]);
  });
});

describe("LinearProvider — refresh-resume surface", () => {
  let c: FakeContainer;
  let provider: LinearProvider;

  function makeProvider(c: FakeContainer): LinearProvider {
    return new LinearProvider(c, {
      gatewayOrigin: "https://gw",
      scopes: DEFAULT_LINEAR_SCOPES,
      defaultCapabilities: ALL_CAPABILITIES,
    });
  }

  beforeEach(() => {
    c = buildFakeContainer();
    provider = makeProvider(c);
  });

  it("resumePublication re-derives the shell URLs for an existing pub", async () => {
    const start = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: "https://avatar/c.png" },
      returnUrl: "https://console/done",
    });

    const resumed = await provider.resumePublication({
      publicationId: start.publicationId,
      userId: "usr_a",
      returnUrl: "https://console/done",
    });

    expect(resumed.publicationId).toBe(start.publicationId);
    expect(resumed.callbackUrl).toBe(start.callbackUrl);
    expect(resumed.webhookUrl).toBe(start.webhookUrl);
    expect(resumed.suggestedAppName).toBe("Coder");
    expect(resumed.suggestedAvatarUrl).toBe("https://avatar/c.png");

    // Still exactly one shell — no new row.
    const pubs = await c.publications.listByUserAndAgent("usr_a", "agt_coder");
    expect(pubs).toHaveLength(1);
  });

  it("resumePublication rejects when userId does not own the publication", async () => {
    const start = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_coder",
      environmentId: "env_dev",
      persona: { name: "Coder", avatarUrl: null },
      returnUrl: "https://r",
    });
    await expect(
      provider.resumePublication({
        publicationId: start.publicationId,
        userId: "usr_attacker",
        returnUrl: "https://r",
      }),
    ).rejects.toThrow(/owner mismatch/);
  });

  it("listPendingByUser returns only in-progress Linear pubs", async () => {
    const one = await provider.startPublication({
      userId: "usr_a",
      agentId: "agt_one",
      environmentId: "env_dev",
      persona: { name: "One", avatarUrl: null },
      returnUrl: "https://r",
    });
    // Push into awaiting_install via setCredentials.
    await c.publications.setCredentials(one.publicationId, {
      clientId: "cid",
      clientSecret: "csec",
      webhookSecret: "wsec",
    });

    // Different user — should be excluded.
    await provider.startPublication({
      userId: "usr_other",
      agentId: "agt_other",
      environmentId: "env_dev",
      persona: { name: "Other", avatarUrl: null },
      returnUrl: "https://r",
    });

    const pending = await c.publications.listPendingByUser("usr_a");
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("awaiting_install");
    expect(pending[0].agentId).toBe("agt_one");
  });
});
