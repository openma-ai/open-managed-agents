// CLI: fire a correctly-signed webhook at an OMA integrations gateway.
//
// Usage:
//   tsx test/mocks/fire-webhook.ts slack <gateway> <pubId> <signingSecret> [text]
//   tsx test/mocks/fire-webhook.ts github-labeled <gateway> <appOmaId> <webhookSecret> [issueNumber] [label]
//   tsx test/mocks/fire-webhook.ts github-comment <gateway> <appOmaId> <webhookSecret> [issueNumber] [text]
//   tsx test/mocks/fire-webhook.ts linear-mention <gateway> <pubId> <webhookSecret> [issueTitle]
//   tsx test/mocks/fire-webhook.ts linear-assigned <gateway> <pubId> <webhookSecret> [issueTitle]
//
// Gateway URL is the integrations gateway origin (e.g.
// https://integrations.staging.openma.dev — NOT the main app). The second
// arg's meaning depends on the provider:
//   - slack / linear: publicationId (from `*_publications` table — webhooks
//     route on a stable publication-keyed URL)
//   - github: appOmaId (from `github_publications.app_oma_id` — GitHub Apps
//     bake the webhook URL into their manifest at registration time, so the
//     URL must be stable from minute one)
//
// Exit code 0 means HTTP 2xx; non-zero means the gateway rejected or errored.

import {
  signSlack,
  signGithub,
  signLinear,
  makeSlackEventCallback,
  makeSlackAppMention,
  makeGithubIssueLabeled,
  makeGithubIssueComment,
  makeLinearIssueMention,
  makeLinearIssueAssigned,
} from "./webhook-signatures";

const [, , kind, gateway, pubOrApp, secret, ...rest] = process.argv;

if (!kind || !gateway || !pubOrApp || !secret) {
  console.error("Usage: tsx fire-webhook.ts <kind> <gateway> <pubId|appOmaId> <secret> [...]");
  console.error("kinds: slack | github-labeled | github-comment | linear-mention | linear-assigned");
  console.error("  slack / linear-*: 3rd arg = publicationId");
  console.error("  github-*: 3rd arg = appOmaId (from github_publications.app_oma_id)");
  process.exit(2);
}

async function postRaw(url: string, body: string, headers: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  const text = await res.text();
  console.log(`POST ${url}`);
  console.log(`  → HTTP ${res.status}`);
  console.log(`  → body: ${text.slice(0, 500)}`);
  if (!res.ok) process.exit(1);
}

(async () => {
  if (kind === "slack") {
    const text = rest[0] ?? "<@U_MOCK_BOT> hello from fire-webhook";
    const envelope = makeSlackEventCallback({
      eventId: `Ev_mock_${Date.now()}`,
      teamId: "T_MOCK",
      apiAppId: "A_MOCK",
      event: makeSlackAppMention({
        channelId: "C_MOCK",
        userId: "U_MOCK_HUMAN",
        text,
      }),
    });
    const body = JSON.stringify(envelope);
    const sig = signSlack(body, secret);
    await postRaw(
      `${gateway}/slack/webhook/pub/${pubOrApp}`,
      body,
      {
        "x-slack-request-timestamp": sig.timestampHeader,
        "x-slack-signature": sig.signatureHeader,
      },
    );
    return;
  }

  if (kind === "github-labeled") {
    const issueNumber = Number(rest[0] ?? "1");
    const label = rest[1] ?? "oma:engage";
    const envelope = makeGithubIssueLabeled({
      installationId: 9999,
      repoFullName: "octocat/mock-repo",
      issueNumber,
      issueTitle: "Mock issue",
      issueBody: "Triggered by fire-webhook.ts",
      labelName: label,
      sender: "mock-user",
    });
    const body = JSON.stringify(envelope);
    const sig = signGithub(body, secret);
    await postRaw(
      `${gateway}/github/webhook/app/${pubOrApp}`,
      body,
      {
        "x-github-event": "issues",
        "x-github-delivery": `dl_mock_${Date.now()}`,
        "x-hub-signature-256": sig.signatureHeader,
      },
    );
    return;
  }

  if (kind === "github-comment") {
    const issueNumber = Number(rest[0] ?? "1");
    const text = rest[1] ?? "follow-up from fire-webhook";
    const envelope = makeGithubIssueComment({
      installationId: 9999,
      repoFullName: "octocat/mock-repo",
      issueNumber,
      commentId: Date.now(),
      commentBody: text,
      sender: "mock-user",
    });
    const body = JSON.stringify(envelope);
    const sig = signGithub(body, secret);
    await postRaw(
      `${gateway}/github/webhook/app/${pubOrApp}`,
      body,
      {
        "x-github-event": "issue_comment",
        "x-github-delivery": `dl_mock_${Date.now()}`,
        "x-hub-signature-256": sig.signatureHeader,
      },
    );
    return;
  }

  if (kind === "linear-mention") {
    const title = rest[0] ?? "Mock issue from fire-webhook";
    const envelope = makeLinearIssueMention({
      workspaceId: "ws_mock",
      issueId: `issue_${Date.now()}`,
      issueIdentifier: `MOCK-${Math.floor(Math.random() * 1000)}`,
      issueTitle: title,
      issueDescription: "Body from fire-webhook.ts",
      actorId: "usr_mock",
    });
    const body = JSON.stringify(envelope);
    const sig = signLinear(body, secret);
    await postRaw(
      `${gateway}/linear/webhook/pub/${pubOrApp}`,
      body,
      { "linear-signature": sig.signatureHeader },
    );
    return;
  }

  if (kind === "linear-assigned") {
    const title = rest[0] ?? "Assigned mock issue";
    const envelope = makeLinearIssueAssigned({
      workspaceId: "ws_mock",
      issueId: `issue_${Date.now()}`,
      issueIdentifier: `MOCK-${Math.floor(Math.random() * 1000)}`,
      issueTitle: title,
      actorId: "usr_mock",
    });
    const body = JSON.stringify(envelope);
    const sig = signLinear(body, secret);
    await postRaw(
      `${gateway}/linear/webhook/pub/${pubOrApp}`,
      body,
      { "linear-signature": sig.signatureHeader },
    );
    return;
  }

  console.error(`unknown kind: ${kind}`);
  process.exit(2);
})();
