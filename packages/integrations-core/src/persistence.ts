// Repository ports — persistence boundary.
//
// Providers and route handlers depend on these interfaces, never on D1 or any
// concrete query builder. Adapters in integrations-adapters-cf implement them
// against D1.
//
// Mutations return the resulting row when useful; reads return null on miss
// rather than throwing. Errors mean infrastructure failure, not "not found".

import type {
  AppCredentials,
  CapabilitySet,
  DispatchRule,
  DispatchRulePatch,
  GitHubAppCredentials,
  Installation,
  Persona,
  Publication,
  PublicationStatus,
  ProviderId,
  SessionGranularity,
  SessionScope,
  SessionScopeStatus,
  SetupLink,
  UserId,
  WorkspaceId,
  InstallKind,
  NewDispatchRule,
  SessionId,
  PublicationMode,
  AgentId,
} from "./domain";

export interface NewInstallation {
  /** OMA tenant that owns this installation. NOT NULL in storage. */
  tenantId: string;
  userId: UserId;
  providerId: ProviderId;
  workspaceId: WorkspaceId;
  workspaceName: string;
  installKind: InstallKind;
  appId: string | null;
  botUserId: string;
  /** Will be encrypted before storage. */
  accessToken: string;
  refreshToken: string | null;
  scopes: ReadonlyArray<string>;
}

export interface InstallationRepo {
  get(id: string): Promise<Installation | null>;
  findByWorkspace(
    providerId: ProviderId,
    workspaceId: WorkspaceId,
    installKind: InstallKind,
    appId: string | null,
  ): Promise<Installation | null>;
  listByUser(userId: UserId, providerId: ProviderId): Promise<ReadonlyArray<Installation>>;
  /**
   * Returns the decrypted access token for a live installation, or null if
   * revoked. Implementations are expected to hold a Crypto instance.
   */
  getAccessToken(id: string): Promise<string | null>;
  /**
   * Returns the decrypted refresh token (if one was persisted), or null. Used
   * by the provider to renew an expired access token without forcing the user
   * to reinstall the OAuth app.
   */
  getRefreshToken(id: string): Promise<string | null>;
  insert(row: NewInstallation): Promise<Installation>;
  /** Set the vault id holding the bearer credential for this install. */
  setVaultId(id: string, vaultId: string): Promise<void>;
  /**
   * Atomically rotate the stored access token (and refresh token, which the
   * provider may rotate alongside). Both values are encrypted before storage.
   * Pass refreshToken=null to leave the existing refresh row untouched only
   * when the upstream response did not return one.
   */
  setTokens(id: string, accessToken: string, refreshToken: string | null): Promise<void>;
  markRevoked(id: string, at: number): Promise<void>;
}

export interface NewPublication {
  /** OMA tenant that owns this publication. See NewInstallation.tenantId. */
  tenantId: string;
  userId: UserId;
  agentId: AgentId;
  installationId: string;
  environmentId: string;
  mode: PublicationMode;
  status: PublicationStatus;
  persona: Persona;
  capabilities: CapabilitySet;
  sessionGranularity: SessionGranularity;
}

export interface PublicationRepo {
  get(id: string): Promise<Publication | null>;
  listByInstallation(installationId: string): Promise<ReadonlyArray<Publication>>;
  listByUserAndAgent(
    userId: UserId,
    agentId: AgentId,
  ): Promise<ReadonlyArray<Publication>>;
  /**
   * Lists publications owned by the given user that are still in-progress —
   * status in {pending_setup, credentials_filled, awaiting_install}. Used by
   * the Console "In-progress installs" surface so a wizard tab the user
   * abandoned mid-setup is visible alongside live publications. The filter
   * is server-side (small partial index suffices); callers don't paginate.
   */
  listPendingByUser(userId: UserId): Promise<ReadonlyArray<Publication>>;
  insert(row: NewPublication): Promise<Publication>;
  updateStatus(id: string, status: PublicationStatus): Promise<void>;
  updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void>;
  updatePersona(id: string, persona: Persona): Promise<void>;
  markUnpublished(id: string, at: number): Promise<void>;
}

/**
 * Insert payload for a publication-first shell row. Carries everything the
 * UX wizard collected up front; credentials and installation binding are
 * filled in by separate calls (`setCredentials`, `bindInstallation`) once
 * the user has registered the OAuth app on Linear's side.
 *
 * `installationId` is intentionally absent — the caller writes the empty
 * string sentinel into `linear_publications.installation_id` until the
 * OAuth callback wires up the real installation row.
 */
export interface NewPublicationShell {
  tenantId: string;
  userId: UserId;
  agentId: AgentId;
  environmentId: string;
  mode: PublicationMode;
  persona: Persona;
  capabilities: CapabilitySet;
  sessionGranularity: SessionGranularity;
}

/** OAuth-app credentials, plaintext on input — repo encrypts at rest. */
export interface PublicationCredentialsInput {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /**
   * Reserved for upstream surfaces that distinguish HMAC-signing key from
   * webhook secret (e.g. Slack). Linear today re-uses webhookSecret for
   * both roles; pass null.
   */
  signingSecret?: string | null;
}

/** Decrypted credentials returned by `getCredentials`. */
export interface PublicationCredentials {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  signingSecret: string | null;
}

/**
 * Linear-specific extension of `PublicationRepo`. Linear's publication-first
 * install flow stashes the OAuth-app credentials directly on the publication
 * row instead of in a separate `linear_apps` table — see migration
 * 0002_linear_publication_first.sql. The new methods are kept on a narrowed
 * port so Slack/GitHub providers don't accidentally reach for them.
 *
 * Lifecycle of a publication-first install:
 *   insertShell  (status='pending_setup')
 *     → setCredentials (status='awaiting_install', secrets encrypted in row)
 *     → bindInstallation (status='live', installation+vault wired in)
 */
export interface LinearPublicationRepo extends PublicationRepo {
  /**
   * Create a publication shell with status='pending_setup'. The
   * installation_id column gets the empty string sentinel; bindInstallation
   * replaces it once OAuth completes.
   */
  insertShell(row: NewPublicationShell): Promise<Publication>;

  /**
   * Persist OAuth credentials on the row and advance status to
   * 'awaiting_install'. Encrypts client_secret / webhook_secret /
   * signing_secret via the same Crypto port that backs token storage.
   */
  setCredentials(id: string, input: PublicationCredentialsInput): Promise<void>;

  /**
   * Returns the decrypted OAuth credentials, or null when the row hasn't
   * had `setCredentials` called yet. Used by the callback handler before
   * Linear token exchange and by the webhook receiver before HMAC check.
   */
  getCredentials(id: string): Promise<PublicationCredentials | null>;

  /** Hot-path getter for the webhook HMAC verifier. */
  getWebhookSecret(id: string): Promise<string | null>;

  /** Hot-path getter for the OAuth `code` exchange + the refresh flow. */
  getClientSecret(id: string): Promise<string | null>;

  /**
   * Bind the freshly-minted installation + vault onto the publication and
   * flip status to 'live'. Idempotent on retry: callers that re-enter the
   * callback (e.g. user double-clicked Install) get the same final state.
   */
  bindInstallation(
    id: string,
    args: { installationId: string; vaultId: string | null },
  ): Promise<void>;
}

export interface NewAppCredentials {
  /**
   * Optional explicit id. When provided, insert behaves as an upsert keyed on
   * id (re-submitting the same App row with the same id updates the
   * credentials in place). When omitted, the repo generates a fresh id.
   */
  id?: string;
  /** OMA tenant that owns these credentials. See NewInstallation.tenantId. */
  tenantId: string;
  /** Null when registered ahead of the related publication (A1 install). */
  publicationId: string | null;
  clientId: string;
  /** Will be encrypted before storage. */
  clientSecret: string;
  /** Will be encrypted before storage. */
  webhookSecret: string;
}

export interface AppRepo {
  get(id: string): Promise<AppCredentials | null>;
  getByPublication(publicationId: string): Promise<AppCredentials | null>;
  /** Returns the decrypted webhook secret for HMAC verification. */
  getWebhookSecret(id: string): Promise<string | null>;
  /** Returns the decrypted client secret for OAuth token exchange. */
  getClientSecret(id: string): Promise<string | null>;
  insert(row: NewAppCredentials): Promise<AppCredentials>;
  /** Set publication_id after the related publication is materialized. */
  setPublicationId(id: string, publicationId: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface NewGitHubAppCredentials {
  /** Optional explicit id; insert behaves as upsert when provided. */
  id?: string;
  /** OMA tenant that owns these credentials. See NewInstallation.tenantId. */
  tenantId: string;
  publicationId: string | null;
  /** Numeric GitHub App id (string-typed so we don't truncate large ints). */
  appId: string;
  appSlug: string;
  botLogin: string;
  clientId: string | null;
  /** Will be encrypted before storage. Pass null when not using OAuth. */
  clientSecret: string | null;
  /** Will be encrypted before storage. */
  webhookSecret: string;
  /** Will be encrypted before storage. PEM-encoded RSA private key. */
  privateKey: string;
}

export interface GitHubAppRepo {
  get(id: string): Promise<GitHubAppCredentials | null>;
  getByPublication(publicationId: string): Promise<GitHubAppCredentials | null>;
  /** Match by GitHub's numeric app_id (e.g. on webhook dispatch). */
  getByAppId(appId: string): Promise<GitHubAppCredentials | null>;
  getWebhookSecret(id: string): Promise<string | null>;
  getClientSecret(id: string): Promise<string | null>;
  /** Returns the decrypted PEM private key for App JWT minting. */
  getPrivateKey(id: string): Promise<string | null>;
  insert(row: NewGitHubAppCredentials): Promise<GitHubAppCredentials>;
  setPublicationId(id: string, publicationId: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface WebhookEventStore {
  /**
   * Atomically inserts the delivery id; returns true if it's new (caller should
   * proceed to dispatch), false if it's a duplicate (caller should return 200
   * immediately).
   *
   * `tenantId` is resolved by the caller from the related installation/App
   * row. NOT NULL — the column is NOT NULL after migration 0002.
   */
  recordIfNew(
    deliveryId: string,
    tenantId: string,
    installationId: string,
    eventType: string,
    receivedAt: number,
  ): Promise<boolean>;
  attachSession(deliveryId: string, sessionId: string): Promise<void>;
  attachPublication(deliveryId: string, publicationId: string): Promise<void>;
  attachError(deliveryId: string, error: string): Promise<void>;
}

/**
 * One row of the linear_events drain queue. Same shape as the legacy
 * PendingEvent (kept verbatim so the drain code path didn't have to change
 * domain types when we collapsed the two tables).
 *
 * Drain order: oldest receivedAt first, capped per tick.
 */
export interface LinearActionableEvent {
  /** Linear's webhook delivery id — same as the row's primary key. Used by
   *  drain to call markProcessed/markFailed against the right row. */
  deliveryId: string;
  tenantId: string;
  publicationId: string;
  eventKind: string;
  /** Serialized NormalizedWebhookEvent. JSON.parse to consume. */
  payload: string;
  receivedAt: number;
  processedAt: number | null;
  processedSessionId: string | null;
  errorMessage: string | null;
}

/**
 * Linear-specific extension of WebhookEventStore. The merged `linear_events`
 * table replaces both `linear_webhook_events` and `linear_pending_events`,
 * so this port carries the queue methods that used to live on PendingEventRepo.
 *
 * Lifecycle of one row:
 *   recordIfNew (skeleton, dedup)
 *     → either attachError (drop, audit only) — invisible to drain
 *     → or markActionable (sets payload_json + event_kind + publication_id)
 *         → drain: listUnprocessed → dispatch → markProcessed | markFailed
 */
export interface LinearEventStore extends WebhookEventStore {
  /**
   * Promote a deduped event into the drain queue. After this call, the row
   * is selected by listUnprocessed until markProcessed/markFailed is called.
   *
   * `payloadJson` is the serialized NormalizedWebhookEvent. Drain code
   * JSON.parses it; LinearProvider.dispatchEvent consumes the parsed shape.
   */
  markActionable(
    deliveryId: string,
    eventKind: string,
    publicationId: string,
    payloadJson: string,
  ): Promise<void>;

  /**
   * Drain hot path. Selects rows where `payload_json IS NOT NULL AND
   * processed_at IS NULL`, oldest first. Partial index keeps the scan cheap
   * regardless of how many processed/dropped rows accumulate.
   */
  listUnprocessed(limit: number): Promise<readonly LinearActionableEvent[]>;

  /**
   * Successful drain → mark processed with the spawned session id. Does NOT
   * delete: rows are GC'd by the 7-day retention sweep so that ops can
   * inspect "what fired and when" via listByPublication.
   */
  markProcessed(
    deliveryId: string,
    sessionId: string,
    processedAtMs: number,
  ): Promise<void>;

  /**
   * Failed drain → mark processed with error_message. Same GC story as
   * markProcessed.
   */
  markFailed(
    deliveryId: string,
    errorMessage: string,
    processedAtMs: number,
  ): Promise<void>;

  /** Ops introspection. Returns actionable events for one publication. */
  listByPublication(
    publicationId: string,
    limit: number,
  ): Promise<readonly LinearActionableEvent[]>;
}

export interface SessionScopeRepo {
  getByScope(publicationId: string, scopeKey: string): Promise<SessionScope | null>;
  /**
   * Insert a fresh scope→session mapping. Returns true when a row was actually
   * inserted, false when the (publication_id, scope_key) row already existed
   * (concurrent winner). Callers receiving false should re-`getByScope` to
   * resume the winner's session and abandon any session they just created.
   */
  insert(row: SessionScope): Promise<boolean>;
  updateStatus(
    publicationId: string,
    scopeKey: string,
    status: SessionScopeStatus,
  ): Promise<void>;
  /**
   * Atomic "re-bind a non-active scope to a fresh session" — used when the
   * dispatcher creates a new session for a scope whose old row exists but
   * is no longer active (status is `completed` / `failed` / `escalated` /
   * etc.), OR a stale `pending` claim (winner crashed before fulfilling).
   * Without this, a stale row blocks every future binding indefinitely:
   *   1. insert() rejects on UNIQUE conflict
   *   2. getByScope() returns the non-active row
   *   3. caller falls through, leaves scope un-rebound
   *   4. next event repeats the cycle → no scope ever points at any session
   * Returns true when the update touched a row (status was non-active OR
   * stale pending, and sessionId got replaced + status set to `active`);
   * false when the row is missing OR currently active OR pending-and-fresh
   * (race) — caller should fall back to resume()-ing the winner or poll.
   *
   * `now` is used to detect stale `pending` claims: rows with status='pending'
   * AND created_at older than the implementation's stale threshold (~60s)
   * are eligible. Rows with status='pending' AND created_at within the
   * threshold are skipped — they belong to a live winner that's still
   * creating its session.
   */
  reassignIfInactive(
    publicationId: string,
    scopeKey: string,
    newSessionId: string,
    now: number,
  ): Promise<boolean>;
  /**
   * Two-phase scope claim — phase 1. INSERT a `(publication_id, scope_key)`
   * row with `status='pending'` and a placeholder `session_id` (typically
   * `_pending_<uuid>`). UNIQUE constraint is the race gate — only one
   * concurrent caller wins. Winner then calls `sessions.create` and
   * `fulfillPending` to write the real id; losers see the pending row in
   * `getByScope` and poll until it flips to `active` (or goes stale).
   *
   * Without this two-phase pattern, concurrent webhook deliveries each
   * call `sessions.create` (an expensive RPC) BEFORE racing the INSERT —
   * the loser's session gets created in DB then orphaned, billing for
   * nothing and inflating the sessions table.
   *
   * Returns true when the row was inserted (we won the claim).
   */
  claimPending(args: {
    tenantId: string;
    publicationId: string;
    scopeKey: string;
    placeholderSessionId: string;
    now: number;
  }): Promise<boolean>;
  /**
   * Two-phase scope claim — phase 2. Atomically writes the real session id
   * and flips status='pending' → 'active'. Returns true on success; false
   * if the row isn't in pending state (claim was already taken over by
   * staleness reclaim, or someone else fulfilled, or row was deleted).
   * On false the caller should NOT trust the row points at their session.
   */
  fulfillPending(
    publicationId: string,
    scopeKey: string,
    sessionId: string,
  ): Promise<boolean>;
  /**
   * Two-phase scope claim — abort. Delete the pending row if `sessions.create`
   * failed, so a retry can re-claim. Only deletes when status='pending' —
   * never wipes an `active` row even if its session id matches our
   * placeholder (defensive against pathological races).
   */
  releasePending(publicationId: string, scopeKey: string): Promise<void>;
  listActive(publicationId: string): Promise<ReadonlyArray<SessionScope>>;
}

// Note: per-issue session storage (Linear's `linear_issue_sessions`,
// GitHub's `github_issue_sessions`) lives in each provider package as
// LinearIssueSessionRepo / GitHubIssueSessionRepo. They have different
// shapes (Linear has PAT-mode `claim`, GitHub doesn't) and back different
// tables — there's no shared interface here on purpose.

export interface NewSetupLink {
  /** OMA tenant that owns this setup link. See NewInstallation.tenantId. */
  tenantId: string;
  publicationId: string;
  createdBy: UserId;
  expiresAt: number;
}

export interface SetupLinkRepo {
  get(token: string): Promise<SetupLink | null>;
  insert(row: NewSetupLink): Promise<SetupLink>;
  markUsed(token: string, usedByEmail: string, usedAt: number): Promise<void>;
  deleteExpired(now: number): Promise<number>;
}

/**
 * Dispatch-rule storage. Backs the cron sweep (autopilot) and the admin
 * API. One rule belongs to exactly one publication; multiple rules per
 * publication are allowed for different filter combinations.
 *
 * `listDueForSweep` is the hot path — called every cron tick. It must be
 * cheap; the index `(enabled, last_polled_at)` is sized for it.
 */
export interface DispatchRuleRepo {
  get(id: string): Promise<DispatchRule | null>;
  insert(input: NewDispatchRule): Promise<DispatchRule>;
  update(id: string, patch: DispatchRulePatch): Promise<DispatchRule | null>;
  delete(id: string): Promise<boolean>;
  listByPublication(publicationId: string): Promise<ReadonlyArray<DispatchRule>>;
  /**
   * For the cron sweep: enabled rules whose `lastPolledAt` is older than
   * `nowMs - pollIntervalSeconds * 1000`, ordered by oldest first. `limit`
   * caps a single tick's work to avoid one slow Linear workspace blocking
   * others.
   */
  listDueForSweep(nowMs: number, limit: number): Promise<ReadonlyArray<DispatchRule>>;
  /** Mark a sweep as completed. Updates `lastPolledAt` only. */
  markPolled(id: string, polledAtMs: number): Promise<void>;
}

/**
 * REMOVED: PendingEventRepo. The merged `linear_events` table folds the
 * queue role into LinearEventStore (see above). Drain methods —
 * markActionable / listUnprocessed / markProcessed / markFailed /
 * listByPublication — moved there verbatim.
 */
