// GitHub webhook payload shapes — typed from GitHub's documented schema with
// only the fields we route on. Keep narrow: parsing more fields later is
// cheap, pretending to know fields we don't is expensive.
//
// Reference: https://docs.github.com/en/webhooks/webhook-events-and-payloads

/** Headers GitHub sends on every webhook POST. Lowercased keys. */
export interface WebhookHeaders {
  /** Event name e.g. "issues", "pull_request", "issue_comment". */
  "x-github-event"?: string;
  /** Per-delivery uuid; doubles as our idempotency key. */
  "x-github-delivery"?: string;
  /** "sha256=<hex>" of the raw body keyed by the App's webhook secret. */
  "x-hub-signature-256"?: string;
}

/**
 * Top-level webhook envelope. GitHub sends this for every event; our parser
 * narrows by `x-github-event` + `action`.
 */
export interface RawWebhookEnvelope {
  action?: string;
  /** Present on all installed-App webhooks; identifies the installation. */
  installation?: { id: number; node_id?: string };
  /** Present on App-related events (installation, installation_repositories). */
  repositories_added?: ReadonlyArray<RawRepository>;
  repositories_removed?: ReadonlyArray<RawRepository>;
  repositories?: ReadonlyArray<RawRepository>;
  /** Present on most repo-scoped events. */
  repository?: RawRepository;
  /** Sender of the event. */
  sender?: RawUser;
  /** Issue payloads (also embedded under PR for issue_comment-on-PR). */
  issue?: RawIssue;
  /** Pull request payloads. */
  pull_request?: RawPullRequest;
  /** Single label payload — present on `issues.labeled` / `unlabeled` and
   *  `pull_request.labeled` / `unlabeled`. The `issue.labels` / `pr.labels`
   *  array reflects post-action state; this field is the specific label
   *  that just changed. */
  label?: { name: string; color?: string };
  /** Comment payloads. */
  comment?: RawComment;
  /** Pull request review payloads. */
  review?: RawReview;
  /** Workflow run payloads. */
  workflow_run?: { id: number; name?: string; conclusion?: string | null; status?: string; html_url?: string };
  /** Check suite payloads. */
  check_run?: { id: number; name?: string; conclusion?: string | null; status?: string; html_url?: string };
}

export interface RawRepository {
  id: number;
  name: string;
  full_name: string;
  html_url?: string;
  private?: boolean;
  default_branch?: string;
}

export interface RawUser {
  id: number;
  login: string;
  type?: "User" | "Bot" | "Organization";
}

export interface RawIssue {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  html_url?: string;
  user?: RawUser;
  labels?: ReadonlyArray<{ name: string }>;
  assignees?: ReadonlyArray<RawUser>;
  /** Set when the issue is actually a PR; differentiates issues from PRs. */
  pull_request?: { html_url: string };
}

export interface RawPullRequest {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  html_url?: string;
  user?: RawUser;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  requested_reviewers?: ReadonlyArray<RawUser>;
  assignees?: ReadonlyArray<RawUser>;
  labels?: ReadonlyArray<{ name: string }>;
}

export interface RawComment {
  id: number;
  body: string;
  user?: RawUser;
  html_url?: string;
}

export interface RawReview {
  id: number;
  state: "approved" | "changes_requested" | "commented" | "dismissed";
  body?: string | null;
  user?: RawUser;
  html_url?: string;
}

/**
 * Notification subtypes we route on.
 *
 * The model is **label-based engagement**: a publication has a `triggerLabel`
 * configured (default: lowercased persona name). Users add this label to any
 * issue or PR to "subscribe" the bot. Once subscribed, every whitelisted
 * event on that issue/PR wakes the bot's session — no need to re-@-mention
 * for follow-ups.
 *
 * `*_engaged`  — whitelisted event on a labeled issue/PR. Dispatch path:
 *                getByIssue → resume if active session exists, otherwise
 *                claimPending + spawn (label was just added or @-mention
 *                fallback fired).
 * `*_unsubscribed` — trigger label removed from an issue/PR. Dispatch path:
 *                close the session for that issue/PR.
 * `installation_*` — App lifecycle. `installation_repos_added` is the
 *                opportunity to auto-create the trigger label in newly
 *                installed repos.
 *
 * Whitelisted engagement actions per resource:
 *   issues:                opened, labeled, edited, reopened
 *   issue_comment:         created
 *   pull_request:          opened, labeled, edited, reopened, ready_for_review,
 *                          synchronize
 *   pull_request_review:   submitted
 *   pull_request_review_comment: created
 *
 * Everything else (assigned/reviewer changes, other-label changes, lock/
 * milestone/transfer/pin, comment edits/deletes, review edits/dismissals)
 * is parsed for observability but routes to kind=null.
 */
export type EventKind =
  | "issue_engaged"
  | "issue_unsubscribed"
  | "pr_engaged"
  | "pr_unsubscribed"
  | "installation_created"
  | "installation_deleted"
  | "installation_repos_added";

/**
 * Normalized event consumed by the router and handler. One per dispatched
 * webhook. `kind` is null for events we receive but don't act on.
 */
export interface NormalizedWebhookEvent {
  kind: EventKind | null;
  /** GitHub installation id (always present on installed-App webhooks). */
  installationId: string | null;
  /** Repository full name like "acme/api". */
  repository: string | null;
  /** Numeric issue or PR number; the same number namespace is shared. */
  itemNumber: number | null;
  /** "issue" or "pull_request" — what `itemNumber` refers to. */
  itemKind: "issue" | "pull_request" | null;
  /** Display title of the issue / PR. */
  itemTitle: string | null;
  /** Plain-text body, may be empty. */
  itemBody: string | null;
  /** Comment / review body when applicable. */
  commentBody: string | null;
  /** Numeric comment id, if applicable. */
  commentId: number | null;
  /** Issue / PR labels (lowercased name) for routing. */
  labels: ReadonlyArray<string>;
  /** GitHub login of the user who triggered this. */
  actorLogin: string | null;
  /** GitHub user id of the actor. */
  actorUserId: number | null;
  /** Echo of `X-GitHub-Delivery` for idempotency. */
  deliveryId: string;
  /** Echo of `X-GitHub-Event` for logging. */
  eventType: string;
  /** Action when the event has one (e.g. "opened", "assigned"). */
  action: string | null;
  /** URL of the issue / PR / comment for human navigation. */
  htmlUrl: string | null;
}

export interface ParseInput {
  eventType: string;
  deliveryId: string;
  raw: RawWebhookEnvelope;
  /**
   * Login of the bot user the App publishes as. Used to filter "@mention"
   * fallback (when the issue/PR isn't labeled but a comment @-mentions us)
   * and to suppress self-loops where the bot's own activity would re-fire.
   */
  botLogin: string | null;
  /**
   * Trigger label name for label-based engagement. When an issue/PR carries
   * this label, whitelisted events on it route as `*_engaged`. Comparison
   * is case-insensitive. `null` = no label engagement; only @-mention
   * fallback is active.
   */
  triggerLabel: string | null;
}

/** Parses a raw GitHub webhook into our normalized shape. Pure function. */
export function parseWebhook({
  eventType,
  deliveryId,
  raw,
  botLogin,
  triggerLabel,
}: ParseInput): NormalizedWebhookEvent | null {
  if (!deliveryId) return null;

  const installationId = raw.installation?.id != null ? String(raw.installation.id) : null;
  const repository = raw.repository?.full_name ?? null;
  const action = raw.action ?? null;

  const base = {
    installationId,
    repository,
    deliveryId,
    eventType,
    action,
    actorLogin: raw.sender?.login ?? null,
    actorUserId: raw.sender?.id ?? null,
  };

  // Self-wakeup guard: if the sender IS the bot, never dispatch.
  // (We still return a parsed envelope for observability — kind=null.)
  // Without this filter, the bot's own comment fires `issue_comment.created`
  // with sender == bot, which would trigger an infinite reply loop.
  const senderIsBot = botLogin != null && raw.sender?.login === botLogin;

  const lowercaseLabels = (l?: ReadonlyArray<{ name: string }>): string[] =>
    Array.isArray(l) ? l.map((x) => x.name.toLowerCase()).filter(Boolean) : [];

  // ─── installation lifecycle ────────────────────────────────────────
  if (eventType === "installation") {
    return {
      ...base,
      kind:
        action === "created" ? "installation_created" :
        action === "deleted" ? "installation_deleted" :
        null,
      itemNumber: null,
      itemKind: null,
      itemTitle: null,
      itemBody: null,
      commentBody: null,
      commentId: null,
      labels: [],
      htmlUrl: null,
    };
  }

  // ─── installation_repositories ─────────────────────────────────────
  // Fired when the user adds/removes repos from the App's installation
  // selection (post-install repo-management). We only act on `added` —
  // that's the trigger to auto-create the trigger label in the new repos.
  // `removed` events are dropped (no cleanup; user removed the repo).
  if (eventType === "installation_repositories") {
    return {
      ...base,
      kind: action === "added" ? "installation_repos_added" : null,
      itemNumber: null,
      itemKind: null,
      itemTitle: null,
      itemBody: null,
      commentBody: null,
      commentId: null,
      labels: [],
      htmlUrl: null,
    };
  }

  // Whitelist of actions that wake the bot when the issue/PR carries the
  // trigger label. Anything outside this set on a labeled issue/PR is
  // treated as metadata change and dropped to avoid noise.
  const ISSUE_ENGAGE_ACTIONS = new Set(["opened", "labeled", "edited", "reopened"]);
  const PR_ENGAGE_ACTIONS = new Set([
    "opened",
    "labeled",
    "edited",
    "reopened",
    "ready_for_review",
    "synchronize",
  ]);

  const triggerLabelLower = triggerLabel?.toLowerCase() ?? null;
  const labelChanged = raw.label?.name?.toLowerCase() ?? null;
  const isTriggerLabelChange =
    triggerLabelLower != null && labelChanged === triggerLabelLower;

  // ─── issues ────────────────────────────────────────────────────────
  if (eventType === "issues" && raw.issue) {
    const issue = raw.issue;
    const labels = lowercaseLabels(issue.labels);
    const hasTriggerLabel =
      triggerLabelLower != null && labels.includes(triggerLabelLower);
    const bodyMentionsBot =
      botLogin != null &&
      typeof issue.body === "string" &&
      commentMentions(issue.body, botLogin);

    let kind: EventKind | null = null;
    if (senderIsBot) {
      kind = null;
    } else if (action === "unlabeled" && isTriggerLabelChange) {
      // User removed our trigger label — explicit unsubscribe signal.
      kind = "issue_unsubscribed";
    } else if (action === "labeled" && isTriggerLabelChange) {
      // User just added our trigger label — primary subscribe path.
      kind = "issue_engaged";
    } else if (hasTriggerLabel && ISSUE_ENGAGE_ACTIONS.has(action ?? "")) {
      // Already-subscribed issue gets a whitelisted event — wake same session.
      kind = "issue_engaged";
    } else if (
      (action === "opened" || action === "edited") &&
      bodyMentionsBot
    ) {
      // @-mention fallback: issue body @-mentions us even though it isn't
      // labeled. Treat like an ad-hoc engagement.
      kind = "issue_engaged";
    } else {
      kind = null;
    }

    return {
      ...base,
      kind,
      itemNumber: issue.number,
      itemKind: "issue",
      itemTitle: issue.title,
      itemBody: issue.body ?? null,
      commentBody: null,
      commentId: null,
      labels,
      htmlUrl: issue.html_url ?? null,
    };
  }

  // ─── pull_request ───────────────────────────────────────────────────
  if (eventType === "pull_request" && raw.pull_request) {
    const pr = raw.pull_request;
    const labels = lowercaseLabels(pr.labels);
    const hasTriggerLabel =
      triggerLabelLower != null && labels.includes(triggerLabelLower);
    const bodyMentionsBot =
      botLogin != null &&
      typeof pr.body === "string" &&
      commentMentions(pr.body, botLogin);

    let kind: EventKind | null = null;
    if (senderIsBot) {
      kind = null;
    } else if (action === "unlabeled" && isTriggerLabelChange) {
      kind = "pr_unsubscribed";
    } else if (action === "labeled" && isTriggerLabelChange) {
      kind = "pr_engaged";
    } else if (hasTriggerLabel && PR_ENGAGE_ACTIONS.has(action ?? "")) {
      kind = "pr_engaged";
    } else if (
      (action === "opened" || action === "edited") &&
      bodyMentionsBot
    ) {
      kind = "pr_engaged";
    } else {
      kind = null;
    }

    return {
      ...base,
      kind,
      itemNumber: pr.number,
      itemKind: "pull_request",
      itemTitle: pr.title,
      itemBody: pr.body ?? null,
      commentBody: null,
      commentId: null,
      labels,
      htmlUrl: pr.html_url ?? null,
    };
  }

  // ─── issue_comment ─────────────────────────────────────────────────
  // GitHub fires `issue_comment` for both issues and PR conversation comments.
  // Routes as engaged if (a) issue/PR carries trigger label, OR (b) the
  // comment body @-mentions the bot (fallback). Edits/deletes are dropped.
  if (eventType === "issue_comment" && raw.issue && raw.comment) {
    const issue = raw.issue;
    const comment = raw.comment;
    const isPr = !!issue.pull_request;
    const labels = lowercaseLabels(issue.labels);
    const hasTriggerLabel =
      triggerLabelLower != null && labels.includes(triggerLabelLower);
    const mentionsBot = botLogin != null && commentMentions(comment.body, botLogin);

    let kind: EventKind | null = null;
    if (senderIsBot) {
      kind = null;
    } else if (action !== "created") {
      kind = null;
    } else if (hasTriggerLabel || mentionsBot) {
      kind = isPr ? "pr_engaged" : "issue_engaged";
    } else {
      kind = null;
    }

    return {
      ...base,
      kind,
      itemNumber: issue.number,
      itemKind: isPr ? "pull_request" : "issue",
      itemTitle: issue.title,
      itemBody: issue.body ?? null,
      commentBody: comment.body,
      commentId: comment.id,
      labels,
      htmlUrl: comment.html_url ?? issue.html_url ?? null,
    };
  }

  // ─── pull_request_review ────────────────────────────────────────────
  // Wakes only when PR is labeled and a NEW review is submitted by someone
  // other than the bot. review.dismissed/edited are noise; drop.
  if (eventType === "pull_request_review" && raw.pull_request && raw.review) {
    const pr = raw.pull_request;
    const labels = lowercaseLabels(pr.labels);
    const hasTriggerLabel =
      triggerLabelLower != null && labels.includes(triggerLabelLower);

    const kind: EventKind | null =
      senderIsBot ? null :
      action === "submitted" && hasTriggerLabel ? "pr_engaged" :
      null;
    return {
      ...base,
      kind,
      itemNumber: pr.number,
      itemKind: "pull_request",
      itemTitle: pr.title,
      itemBody: pr.body ?? null,
      commentBody: raw.review.body ?? null,
      commentId: raw.review.id,
      labels,
      htmlUrl: raw.review.html_url ?? pr.html_url ?? null,
    };
  }

  // ─── pull_request_review_comment ────────────────────────────────────
  // Inline code comments (including replies — `in_reply_to_id` field).
  // Same rules as issue_comment: engaged if labeled or @-mentioned.
  if (eventType === "pull_request_review_comment" && raw.pull_request && raw.comment) {
    const pr = raw.pull_request;
    const labels = lowercaseLabels(pr.labels);
    const hasTriggerLabel =
      triggerLabelLower != null && labels.includes(triggerLabelLower);
    const mentionsBot = botLogin != null && commentMentions(raw.comment.body, botLogin);

    let kind: EventKind | null = null;
    if (senderIsBot) {
      kind = null;
    } else if (action !== "created") {
      kind = null;
    } else if (hasTriggerLabel || mentionsBot) {
      kind = "pr_engaged";
    } else {
      kind = null;
    }

    return {
      ...base,
      kind,
      itemNumber: pr.number,
      itemKind: "pull_request",
      itemTitle: pr.title,
      itemBody: pr.body ?? null,
      commentBody: raw.comment.body,
      commentId: raw.comment.id,
      labels,
      htmlUrl: raw.comment.html_url ?? pr.html_url ?? null,
    };
  }

  // ─── workflow_run / check_run failures ──────────────────────────────
  // Default matrix: NOT dispatched. These are CI-bot territory; a future
  // --mode ci-watch binding can opt into them. We still parse for
  // observability so an oma operator can see what's flowing through.
  if (eventType === "workflow_run" && raw.workflow_run) {
    const wr = raw.workflow_run;
    return {
      ...base,
      kind: null,
      itemNumber: null,
      itemKind: null,
      itemTitle: wr.name ?? "workflow",
      itemBody: null,
      commentBody: null,
      commentId: null,
      labels: [],
      htmlUrl: wr.html_url ?? null,
    };
  }
  if (eventType === "check_run" && raw.check_run) {
    const cr = raw.check_run;
    return {
      ...base,
      kind: null,
      itemNumber: null,
      itemKind: null,
      itemTitle: cr.name ?? "check",
      itemBody: null,
      commentBody: null,
      commentId: null,
      labels: [],
      htmlUrl: cr.html_url ?? null,
    };
  }

  // Fall-through: still record the event for idempotency / observability.
  return {
    ...base,
    kind: null,
    itemNumber: null,
    itemKind: null,
    itemTitle: null,
    itemBody: null,
    commentBody: null,
    commentId: null,
    labels: [],
    htmlUrl: null,
  };
}

/**
 * `@<login>` mention check. Case-insensitive, allows `@<login>` followed by
 * end-of-input, whitespace, or a punctuation char. Doesn't try to be smart
 * about code blocks — overcounting is OK; the agent's harness can still ignore
 * spurious wakeups.
 *
 * GitHub Apps surface as `<slug>[bot]` for ownership/audit, but humans @-
 * mention them by typing `@<slug>` (GitHub's autocomplete strips the suffix
 * before the `@` token reaches the comment body). Match both forms.
 */
function commentMentions(body: string, botLogin: string): boolean {
  const candidates = new Set<string>([botLogin]);
  const stripped = botLogin.endsWith("[bot]") ? botLogin.slice(0, -"[bot]".length) : null;
  if (stripped) candidates.add(stripped);
  for (const name of candidates) {
    const re = new RegExp(`@${escapeRegex(name)}(?![A-Za-z0-9_-])`, "i");
    if (re.test(body)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
