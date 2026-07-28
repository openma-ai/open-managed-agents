// Webhook signature helpers — produce correctly-signed envelopes for
// Linear / GitHub / Slack so e2e scripts can synthesize inbound webhooks
// without standing up the real provider.
//
// All three providers sign HMAC-SHA256 over the raw body. They differ in:
//   - Slack: signs `v0:{timestamp}:{rawBody}`; header `X-Slack-Signature: v0=<hex>`
//   - GitHub: signs `rawBody` directly; header `X-Hub-Signature-256: sha256=<hex>`
//   - Linear: signs `rawBody` directly; header `Linear-Signature: <hex>`
//
// The bodies are NOT pretty-printed — sign exactly what you POST. JSON.stringify
// the envelope once, sign that string, then send the same string as the request
// body. Re-stringifying will break the signature.

import { createHmac } from "node:crypto";

// ─── Slack ─────────────────────────────────────────────────────────────

export function signSlack(
  rawBody: string,
  signingSecret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): { signature: string; timestampHeader: string; signatureHeader: string } {
  const ts = String(timestamp);
  const baseString = `v0:${ts}:${rawBody}`;
  const h = createHmac("sha256", signingSecret).update(baseString).digest("hex");
  return {
    signature: `v0=${h}`,
    timestampHeader: ts,
    signatureHeader: `v0=${h}`,
  };
}

/** Minimal Slack `event_callback` envelope. Mirror real fields the parser reads. */
export function makeSlackEventCallback(opts: {
  eventId: string;
  teamId: string;
  apiAppId: string;
  event: Record<string, unknown>;
  /** Optional auth context Slack passes through. */
  authorizations?: Array<{ team_id: string; user_id: string }>;
}): Record<string, unknown> {
  return {
    type: "event_callback",
    event_id: opts.eventId,
    event_time: Math.floor(Date.now() / 1000),
    team_id: opts.teamId,
    api_app_id: opts.apiAppId,
    event: opts.event,
    authorizations: opts.authorizations ?? [
      { team_id: opts.teamId, user_id: "U_MOCK_BOT" },
    ],
  };
}

/** `app_mention` event payload. The agent's signal trigger on Slack. */
export function makeSlackAppMention(opts: {
  channelId: string;
  userId: string;
  text: string;
  ts?: string;
  threadTs?: string;
}): Record<string, unknown> {
  const eventTs = opts.ts ?? `${Date.now() / 1000}`;
  return {
    type: "app_mention",
    user: opts.userId,
    text: opts.text,
    channel: opts.channelId,
    ts: eventTs,
    event_ts: eventTs,
    ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
  };
}

// ─── GitHub ────────────────────────────────────────────────────────────

export function signGithub(
  rawBody: string,
  webhookSecret: string,
): { signatureHeader: string } {
  const h = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return { signatureHeader: `sha256=${h}` };
}

/** `issues` event with `action=labeled` — the label-based bot trigger path. */
export function makeGithubIssueLabeled(opts: {
  installationId: number;
  repoFullName: string; // e.g. "octocat/hello-world"
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  labelName: string; // the trigger label
  sender: string; // GitHub login
}): Record<string, unknown> {
  const [owner, name] = opts.repoFullName.split("/");
  return {
    action: "labeled",
    issue: {
      number: opts.issueNumber,
      title: opts.issueTitle,
      body: opts.issueBody,
      state: "open",
      user: { login: opts.sender, id: 1, type: "User" },
      labels: [{ name: opts.labelName }],
    },
    label: { name: opts.labelName },
    repository: {
      id: 1,
      name,
      full_name: opts.repoFullName,
      owner: { login: owner, id: 1 },
    },
    sender: { login: opts.sender, id: 1, type: "User" },
    installation: { id: opts.installationId },
  };
}

/** `issue_comment` event — the wake-on-comment path. */
export function makeGithubIssueComment(opts: {
  installationId: number;
  repoFullName: string;
  issueNumber: number;
  commentId: number;
  commentBody: string;
  sender: string;
}): Record<string, unknown> {
  const [owner, name] = opts.repoFullName.split("/");
  return {
    action: "created",
    issue: {
      number: opts.issueNumber,
      title: "issue",
      state: "open",
      user: { login: opts.sender, id: 1 },
    },
    comment: {
      id: opts.commentId,
      body: opts.commentBody,
      user: { login: opts.sender, id: 1 },
    },
    repository: {
      id: 1,
      name,
      full_name: opts.repoFullName,
      owner: { login: owner, id: 1 },
    },
    sender: { login: opts.sender, id: 1 },
    installation: { id: opts.installationId },
  };
}

// ─── Linear ────────────────────────────────────────────────────────────

export function signLinear(
  rawBody: string,
  webhookSecret: string,
): { signatureHeader: string } {
  const h = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return { signatureHeader: h };
}

/** `IssueMention` action — bot got mentioned in an issue. */
export function makeLinearIssueMention(opts: {
  workspaceId: string;
  issueId: string;
  issueIdentifier: string; // e.g. "ENG-123"
  issueTitle: string;
  issueDescription: string;
  actorId: string;
}): Record<string, unknown> {
  return {
    action: "create",
    type: "IssueMention",
    organizationId: opts.workspaceId,
    data: {
      issue: {
        id: opts.issueId,
        identifier: opts.issueIdentifier,
        title: opts.issueTitle,
        description: opts.issueDescription,
        state: { name: "Todo" },
      },
      actor: { id: opts.actorId, name: "mock-user" },
    },
    createdAt: new Date().toISOString(),
    webhookId: "wh_mock",
  };
}

/** `IssueAssignedToYou` — same as @-mention but via assignee. */
export function makeLinearIssueAssigned(opts: {
  workspaceId: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  actorId: string;
}): Record<string, unknown> {
  return {
    action: "create",
    type: "IssueAssignedToYou",
    organizationId: opts.workspaceId,
    data: {
      issue: {
        id: opts.issueId,
        identifier: opts.issueIdentifier,
        title: opts.issueTitle,
        state: { name: "Todo" },
      },
      actor: { id: opts.actorId, name: "mock-user" },
    },
    createdAt: new Date().toISOString(),
    webhookId: "wh_mock",
  };
}
