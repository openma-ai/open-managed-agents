// DTO shapes returned by apps/main /v1/integrations/* endpoints. Keep
// snake_case to match the wire format — JS clients can still read them
// without ceremony.

// ─── Linear ────────────────────────────────────────────────────────────

export interface LinearInstallation {
  id: string;
  workspace_id: string;
  workspace_name: string;
  install_kind: "dedicated";
  bot_user_id: string;
  vault_id: string | null;
  created_at: number;
}

export interface LinearPublication {
  id: string;
  user_id: string;
  agent_id: string;
  installation_id: string;
  environment_id: string;
  mode: "full";
  status: "pending_setup" | "awaiting_install" | "live" | "needs_reauth" | "unpublished";
  persona: { name: string; avatarUrl: string | null };
  capabilities: string[];
  session_granularity: "per_issue" | "per_event";
  created_at: number;
  unpublished_at: number | null;
}

// ─── Slack ─────────────────────────────────────────────────────────────

export interface SlackInstallation {
  id: string;
  workspace_id: string;
  workspace_name: string;
  install_kind: "dedicated";
  bot_user_id: string;
  vault_id: string | null;
  created_at: number;
}

export interface SlackPublication {
  id: string;
  user_id: string;
  agent_id: string;
  installation_id: string;
  environment_id: string;
  mode: "full";
  /** credentials_filled is reserved — current Slack adapter elides it
   *  (jumps pending_setup → awaiting_install on first setCredentials), but
   *  the schema accepts it and pending-pub clients should handle it. */
  status:
    | "pending_setup"
    | "credentials_filled"
    | "awaiting_install"
    | "live"
    | "needs_reauth"
    | "unpublished";
  persona: { name: string; avatarUrl: string | null };
  capabilities: string[];
  /** Slack defaults to per_thread; per_event also supported. */
  session_granularity: "per_thread" | "per_event";
  created_at: number;
  unpublished_at: number | null;
}

// ─── Shared install-flow shapes ─────────────────────────────────────────

/** First step result — handed to the user as a credentials form. */
export interface A1FormStep {
  formToken: string;
  suggestedAppName: string;
  suggestedAvatarUrl: string | null;
  callbackUrl: string;
  /** OAuth Redirect URL for Linear; Events Request URL for Slack. */
  webhookUrl: string;
  /**
   * Slack-only: pre-filled "Create from manifest" URL the user can open to
   * have Slack auto-configure the App with all scopes/events/redirect URLs.
   * Linear's analogous flow is built into linear.app and needs no URL.
   */
  manifestLaunchUrl?: string | null;
  /**
   * Slack publication-first only: the OMA publication id minted by the
   * shell-create. The wizard surfaces it for ops/debug; the API client uses
   * it implicitly via the formToken JWT (no client-side state needed).
   */
  publicationId?: string;
}

export interface A1InstallLink {
  /** OAuth URL the user clicks to authorize the install. */
  url: string;
  /**
   * Slack publication-first: the OMA publication id (legacy Linear A1: app
   * id). Both flows surface an opaque identifier here; the wizard just shows
   * it for the user.
   */
  appId?: string;
  publicationId?: string;
  callbackUrl: string;
  webhookUrl: string;
}

export interface HandoffLink {
  url: string;
  expiresInDays: number;
}

export interface PublishWizardInput {
  agentId: string;
  environmentId: string;
  personaName: string;
  personaAvatarUrl?: string | null;
  /** Where to redirect when install completes. */
  returnUrl: string;
}

// ─── Slack-specific input narrows ──────────────────────────────────────

export interface SlackSubmitCredentialsInput {
  formToken: string;
  clientId: string;
  clientSecret: string;
  /** Slack's per-App Signing Secret (from App admin → Basic Information). */
  signingSecret: string;
}

export interface LinearSubmitCredentialsInput {
  formToken: string;
  clientId: string;
  clientSecret: string;
  /** Linear's webhook signing secret (lin_wh_…). */
  webhookSecret: string;
}

/** Step 1 result of the Linear publication-first install: a server-side
 *  publication shell row created with status='pending_setup'. The user
 *  pastes the callback + webhook URLs into Linear's OAuth-app form, then
 *  submits credentials via PATCH .../credentials. */
export interface LinearPublicationShell {
  publication_id: string;
  callback_url: string;
  webhook_url: string;
  suggested_app_name: string;
  suggested_avatar_url: string | null;
  return_url: string;
}

/** Step 2 result: the OAuth authorize URL the user clicks to bind the
 *  installation to the publication. Echoes back the callback/webhook URLs
 *  for client-side verification (they must match what was pasted into
 *  Linear). */
export interface LinearPublicationInstallLink {
  install_url: string;
  publication_id: string;
  callback_url: string;
  webhook_url: string;
}

/** Step 2 input. */
export interface LinearPublicationCredentialsInput {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** Reserved — Linear today reuses webhookSecret as the HMAC key. */
  signingSecret?: string | null;
  /** Carried through to the OAuth state JWT so the callback can build
   *  the final 302 target. */
  returnUrl: string;
}

/** Symphony-equivalent install — Personal API Key in one shot, no OAuth dance. */
export interface LinearPersonalTokenInput {
  agentId: string;
  environmentId: string;
  personaName: string;
  personaAvatarUrl?: string | null;
  /** Linear PAT, format `lin_api_…`. Validated via viewer query before vault write. */
  patToken: string;
}

export interface LinearPersonalTokenResult {
  publicationId: string;
}

/** Cron-driven autopilot rule. One rule belongs to one publication. */
export interface LinearDispatchRule {
  id: string;
  publication_id: string;
  name: string;
  enabled: boolean;
  filter_label: string | null;
  filter_states: string[] | null;
  filter_project_id: string | null;
  max_concurrent: number;
  poll_interval_seconds: number;
  last_polled_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface LinearDispatchRuleInput {
  name?: string;
  enabled?: boolean;
  filter_label?: string | null;
  filter_states?: string[] | null;
  filter_project_id?: string | null;
  max_concurrent?: number;
  poll_interval_seconds?: number;
}

// ─── GitHub ────────────────────────────────────────────────────────────

export interface GitHubInstallation {
  id: string;
  /** Numeric GitHub installation_id (string-typed). */
  workspace_id: string;
  /** Org or user login (e.g. "acme"). */
  workspace_name: string;
  install_kind: "dedicated";
  /** Bot login the App acts as (e.g. "myapp[bot]"). */
  bot_login: string;
  vault_id: string | null;
  created_at: number;
}

export interface GitHubPublication {
  id: string;
  user_id: string;
  agent_id: string;
  installation_id: string;
  environment_id: string;
  mode: "full";
  status: "pending_setup" | "credentials_filled" | "awaiting_install" | "live" | "needs_reauth" | "unpublished";
  persona: { name: string; avatarUrl: string | null };
  capabilities: string[];
  session_granularity: "per_issue" | "per_event";
  created_at: number;
  unpublished_at: number | null;
}

export interface GitHubA1FormStep {
  formToken: string;
  /** Publication-first: id of the github_publications shell row we just
   *  created. Wizard tracks this for polling and `?publication_id=` query
   *  string round-trips. */
  publicationId: string;
  appOmaId: string;
  suggestedAppName: string;
  suggestedAvatarUrl: string | null;
  setupUrl: string;
  webhookUrl: string;
  /** Recommended UX path: opens a manifest auto-POST page on the gateway
   *  that streamlines App registration to ~30s. Optional because not every
   *  step variant exposes it (e.g. server-side resumed flows). */
  manifestStartUrl?: string;
  recommendedPermissions: Record<string, string>;
  recommendedSubscriptions: string[];
}

export interface GitHubA1InstallLink {
  url: string;
  /** Publication-first: same id as on GitHubA1FormStep. */
  publicationId: string;
  appOmaId: string;
  appSlug: string;
  botLogin: string;
  setupUrl: string;
  webhookUrl: string;
}

// ─── Sessions (subset, used by activity timeline) ────────────────────────
//
// Mirrors a slice of @open-managed-agents/shared SessionMeta. Kept inline
// here so the console UI stays decoupled from the host server's type
// package — snake-case shapes match the wire format.

export interface SessionSummary {
  id: string;
  agent_id: string;
  environment_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at?: string;
  archived_at?: string;
  /**
   * Free-form metadata stamped at session create time. The github provider
   * writes `{ github: { installationId, repository, eventKind, ... } }`;
   * the linear provider writes its own shape. Activity-feed consumers
   * narrow this themselves rather than us pretending one shape fits all.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Fields the github provider stamps onto session.metadata.github at create
 * time. See packages/github/src/provider.ts. Optional because the same
 * SessionSummary type is reused for non-github sessions.
 */
export interface GitHubSessionMetadata {
  installationId?: string;
  repository?: string;
  itemKind?: "issue" | "pull_request" | null;
  itemNumber?: number | null;
  commentId?: number | null;
  actorLogin?: string | null;
  eventKind?: string | null;
  eventType?: string;
  deliveryId?: string;
  htmlUrl?: string | null;
  /** Set on per_issue sessions for resume keying. */
  issueKey?: string;
}
