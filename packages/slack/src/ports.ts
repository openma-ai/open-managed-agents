// Slack-specific port extensions.
//
// Slack's install carries TWO tokens (bot xoxb- + user xoxp-) where Linear's
// carries one, plus needs two vault ids (one per token). This narrower repo
// extends InstallationRepo with the additional Slack-only methods. Linear's
// repo doesn't implement it; the SlackContainer wires its own
// SlackInstallationRepo implementation.

import type {
  InstallationRepo,
  PublicationRepo,
  SessionScopeRepo,
} from "@open-managed-agents/integrations-core";

export interface SlackInstallationRepo extends InstallationRepo {
  /**
   * Returns the decrypted user (`xoxp-`) token for an installation, or null
   * if the installation is revoked or the token wasn't stored. Required for
   * `mcp.slack.com/mcp` outbound auth — the bot token (`xoxb-`) is rejected
   * by Slack's hosted MCP server.
   */
  getUserToken(id: string): Promise<string | null>;

  /** Persist the encrypted user (xoxp-) token after OAuth completion. */
  setUserToken(id: string, userToken: string): Promise<void>;

  /** Set the secondary vault id holding the bot xoxb- token. */
  setBotVaultId(id: string, botVaultId: string): Promise<void>;

  /** Returns the bot xoxb- vault id for outbound injection on slack.com/api. */
  getBotVaultId(id: string): Promise<string | null>;
}

/**
 * Publication-first install state stored on each `slack_publications` row.
 * Returned alongside the base Publication shape so the provider can discover
 * what stage of the wizard the user has reached.
 *
 * Lifecycle:
 *   pending_setup       — shell-created. callback URL minted, no creds.
 *   credentials_filled  — clientId / *_cipher columns set; ready for OAuth.
 *   awaiting_install    — OAuth URL handed to user; waiting for redirect.
 *   live                — OAuth callback completed: installation, vaults,
 *                         slack_app_id all bound.
 *
 *   needs_reauth / unpublished — terminal-ish, same as base PublicationStatus.
 */
export interface SlackPublicationCredentialState {
  clientId: string | null;
  hasClientSecret: boolean;
  hasSigningSecret: boolean;
  /** Slack-side app id (e.g. A07ABC…). Populated on OAuth complete. */
  slackAppId: string | null;
}

export interface SlackPublicationRepo extends PublicationRepo {
  /**
   * Insert a "shell" Slack publication — minimum row needed to mint a
   * callback URL. installation_id is "" (sentinel — D1 column is NOT NULL),
   * status='pending_setup', no credentials, no Slack-side app.
   *
   * The provider's startPublication is the only caller; route handlers use
   * the base PublicationRepo.insert for legacy paths.
   */
  insertShell(input: {
    tenantId: string;
    userId: string;
    agentId: string;
    environmentId: string;
    persona: { name: string; avatarUrl: string | null };
    capabilities: ReadonlySet<import("@open-managed-agents/integrations-core").CapabilityKey>;
    sessionGranularity: import("@open-managed-agents/integrations-core").SessionGranularity;
  }): Promise<import("@open-managed-agents/integrations-core").Publication>;

  /**
   * PATCH the encrypted credentials onto a shell publication. Idempotent:
   * re-pasting overwrites cipher columns, no row duplication. Flips status
   * 'pending_setup' → 'credentials_filled' (or stays 'credentials_filled' on
   * re-paste; never downgrades from a more advanced status).
   *
   * Throws if the publication doesn't exist.
   */
  setCredentials(
    publicationId: string,
    input: { clientId: string; clientSecretCipher: string; signingSecretCipher: string },
  ): Promise<void>;

  /**
   * Retrieve the decrypted client_secret for OAuth code-exchange. Caller
   * passes the publication-id from the callback URL. Returns null when the
   * publication is missing or has no credentials yet (caller surfaces 400).
   */
  getClientSecret(publicationId: string): Promise<string | null>;

  /**
   * Retrieve the decrypted signing_secret for HMAC verification on incoming
   * Slack events. Used by the webhook handler when binding by app_id maps
   * to a publication.
   */
  getSigningSecret(publicationId: string): Promise<string | null>;

  /**
   * Read just the credential staging columns. Provider uses this to discover
   * what stage of the wizard a publication is at (e.g. on retry — re-paste
   * vs. fresh shell vs. re-do OAuth).
   */
  getCredentialState(
    publicationId: string,
  ): Promise<SlackPublicationCredentialState | null>;

  /**
   * After OAuth completes: bind the Slack-side app_id, the just-created
   * installation_id, and flip status='live'. Called once per publication.
   * Idempotent — re-running with the same arguments is a no-op.
   */
  bindInstallation(input: {
    publicationId: string;
    installationId: string;
    slackAppId: string;
  }): Promise<void>;

  /**
   * Look up a publication by Slack's app_id (A07…). Used by the webhook
   * receiver: Slack's payload identifies the App but not OMA's publication;
   * we fan-in via this lookup. Returns null when no publication has bound
   * this Slack app yet.
   */
  findBySlackAppId(slackAppId: string): Promise<
    import("@open-managed-agents/integrations-core").Publication | null
  >;
}

/**
 * Slack-specific session scope methods on top of the generic SessionScopeRepo.
 * These exist for `per_channel` granularity — debounced channel-scope scan
 * dispatch + cached channel display name. Linear/GitHub providers don't need
 * these and Linear's IssueSessionRepo is a separate type entirely.
 */
export interface SlackSessionScopeRepo extends SessionScopeRepo {
  /**
   * Atomically check-and-set the debounce watermark on a channel scope row.
   *
   * - If the row's `pending_scan_until` is NULL or `<= now`: UPDATE to `until`
   *   and return `{ armed: true, currentUntil: null }`. The caller should
   *   dispatch a `[signal:channel_scan_armed]` event to the agent.
   * - Otherwise: return `{ armed: false, currentUntil: existingValue }`. The
   *   caller should drop this event silently (a scan is already armed).
   *
   * Concurrent callers are serialized by D1's row-level locking — one wins,
   * the other reads the winner's value and gets `armed: false`.
   *
   * No-op (returns `{ armed: false, currentUntil: null }`) when the
   * (publication_id, scope_key) row doesn't yet exist; callers should ensure
   * the channel session row exists before arming.
   */
  armPendingScan(
    publicationId: string,
    scopeKey: string,
    until: number,
    now: number,
  ): Promise<{ armed: boolean; currentUntil: number | null }>;

  /** Clear the debounce watermark — no-op if not currently armed. */
  clearPendingScan(publicationId: string, scopeKey: string): Promise<void>;

  /** Update the cached channel display name on a channel-scope row. */
  updateChannelName(
    publicationId: string,
    scopeKey: string,
    channelName: string,
  ): Promise<void>;

  /**
   * Mark every active scope row for a publication as completed and clear any
   * pending scan watermark. Called from the `tokens_revoked` / `app_uninstalled`
   * lifecycle path when the whole installation is gone — without this, stale
   * `active` rows linger and any agent scheduleWakeups would burn turns
   * 401-ing against a revoked token.
   */
  closeAllForPublication(publicationId: string): Promise<void>;
}
