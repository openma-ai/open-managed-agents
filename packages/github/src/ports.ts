// GitHub-specific port extensions.
//
// GitHub's publication-first install needs richer state on each
// `github_publications` row than the base `PublicationRepo` exposes:
// pre-allocated `app_oma_id`, encrypted credential ciphers (client_secret,
// webhook_secret, private_key PEM), plaintext app_id/app_slug/bot_login, and
// a vault_id slot bound at OAuth-callback time. The base repo handles status
// transitions and persona updates; this narrower repo adds the credential
// staging + install-binding methods.
//
// Same pattern Slack uses (see packages/slack/src/ports.ts) — keep the
// provider-specific bits behind a narrowed repo so the cross-cutting
// IntegrationsRepoBag stays generic.

import type {
  CapabilityKey,
  Persona,
  Publication,
  PublicationRepo,
  SessionGranularity,
} from "@open-managed-agents/integrations-core";

/**
 * Publication-first install state stored on each `github_publications` row.
 * Returned alongside the base Publication shape so the provider can discover
 * what stage of the wizard the user has reached.
 *
 * Lifecycle:
 *   pending_setup       — shell-created. callback URL minted, no creds.
 *   credentials_filled  — appOmaId pre-allocated; app_id / *_cipher columns
 *                         set; ready for the user to click Install.
 *   awaiting_install    — install URL handed to user; waiting for the
 *                         GitHub callback redirect. (Same row as
 *                         credentials_filled — status flips when the install
 *                         link is rendered, idempotent.)
 *   live                — install callback completed: installation, vaults,
 *                         vault_id all bound back onto the publication row.
 *
 *   needs_reauth / unpublished — terminal-ish, same as base PublicationStatus.
 */
export interface GitHubPublicationCredentialState {
  /** Pre-allocated github_apps row id. Set at shell create so the webhook
   *  URL — `/github/webhook/app/<appOmaId>` — is stable from minute one. */
  appOmaId: string | null;
  /** GitHub's numeric App id (e.g. "7654321"). Set at credentials submit. */
  appId: string | null;
  /** App slug from `GET /app` (e.g. "coder-bot"). Set at credentials submit. */
  appSlug: string | null;
  /** Bot login (e.g. "coder-bot[bot]"). Set at credentials submit. */
  botLogin: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  hasWebhookSecret: boolean;
  hasPrivateKey: boolean;
  /** Vault id holding the installation token. Set on OAuth callback. */
  vaultId: string | null;
}

export interface GitHubPublicationRepo extends PublicationRepo {
  /**
   * Insert a "shell" GitHub publication — minimum row needed to mint a
   * stable webhook URL up-front. installation_id is "" (sentinel — the D1
   * column is NOT NULL), status='pending_setup', no credentials. The repo
   * pre-allocates `app_oma_id` so the caller's `dedicatedWebhookUri` can
   * use it from minute one.
   *
   * The provider's startInstall is the only caller; route handlers use
   * the base PublicationRepo.insert for legacy paths.
   */
  insertShell(input: {
    tenantId: string;
    userId: string;
    agentId: string;
    environmentId: string;
    persona: Persona;
    capabilities: ReadonlySet<CapabilityKey>;
    sessionGranularity: SessionGranularity;
  }): Promise<{ publication: Publication; appOmaId: string }>;

  /**
   * PATCH the encrypted credentials onto a shell publication. Idempotent:
   * re-pasting overwrites cipher columns, no row duplication. Flips status
   * 'pending_setup' → 'credentials_filled' (or stays 'credentials_filled'
   * on re-paste; never downgrades from a more advanced status).
   *
   * Throws if the publication doesn't exist or has been unpublished.
   */
  setCredentials(
    publicationId: string,
    input: {
      appId: string;
      appSlug: string;
      botLogin: string;
      clientId: string | null;
      clientSecretCipher: string | null;
      webhookSecretCipher: string;
      privateKeyCipher: string;
    },
  ): Promise<void>;

  /** Decrypted client_secret for OAuth code-exchange. */
  getClientSecret(publicationId: string): Promise<string | null>;
  /** Decrypted webhook_secret for HMAC verification on incoming events. */
  getWebhookSecret(publicationId: string): Promise<string | null>;
  /** Decrypted PEM private key for App-JWT minting (installation token). */
  getPrivateKey(publicationId: string): Promise<string | null>;

  /**
   * Read just the credential staging columns. Provider uses this to
   * discover what stage of the wizard a publication is at (e.g. on retry —
   * re-paste vs. fresh shell vs. re-do install).
   */
  getCredentialState(
    publicationId: string,
  ): Promise<GitHubPublicationCredentialState | null>;

  /**
   * After install callback completes: bind the just-created installation_id
   * + vault_id onto the publication and flip status='live'. Idempotent —
   * re-running with the same arguments is a no-op (still flips status).
   */
  bindInstallation(input: {
    publicationId: string;
    installationId: string;
    vaultId: string;
  }): Promise<void>;

  /**
   * Lookup by the pre-allocated `app_oma_id`. The webhook receiver's primary
   * path uses this so it can read signing material straight from the
   * publication row — no JOIN through github_apps.
   */
  findByAppOmaId(appOmaId: string): Promise<Publication | null>;

  /**
   * Read the trigger label for label-based engagement. Returns the
   * `trigger_label` column verbatim — caller is responsible for empty-string
   * / null disambiguation. The provider uses this in the webhook parser
   * (label match) and the install hook (auto-create label in repos).
   */
  getTriggerLabel(publicationId: string): Promise<string | null>;

  /**
   * Update the trigger label. Wizard "edit publication" path uses this to
   * let users rename the label without re-publishing. Provider may also
   * call it as part of insertShell defaults — in that case `trigger_label`
   * is set to a slugified persona name.
   */
  setTriggerLabel(publicationId: string, label: string): Promise<void>;
}

// ─── per-issue session bookkeeping ─────────────────────────────────────────
// Twin of LinearIssueSessionRepo (packages/linear/src/ports.ts), backed by
// the separate `github_issue_sessions` table. Strictly isolated from Linear:
// different storage, different interface, different repo class. GitHub has
// no PAT mode (App-only install path), so there's no `claim` method here —
// only the two-phase webhook claim used by dispatchEvent against the
// concurrent issues.* + issue_comment.* webhook race.

import type { SessionId } from "@open-managed-agents/integrations-core";

export type GitHubIssueSessionStatus = "pending" | "active" | "failed" | "inactive";

export interface GitHubIssueSession {
  tenantId: string;
  publicationId: string;
  /** "<owner/repo>#<number>" */
  issueId: string;
  sessionId: SessionId;
  status: GitHubIssueSessionStatus;
  createdAt: number;
}

export interface GitHubIssueSessionRepo {
  getByIssue(
    publicationId: string,
    issueId: string,
  ): Promise<GitHubIssueSession | null>;

  /**
   * Two-phase webhook claim — phase 1. INSERT OR IGNORE at status='pending'
   * with empty placeholder session_id. Returns true when this caller won
   * the claim, false when a sibling webhook delivery beat us to it.
   */
  claimPending(args: {
    tenantId: string;
    publicationId: string;
    issueId: string;
    nowMs: number;
  }): Promise<boolean>;

  /** Two-phase webhook claim — phase 2. UPDATE pending → active with the
   *  real session id. */
  fulfillPending(
    publicationId: string,
    issueId: string,
    sessionId: SessionId,
  ): Promise<boolean>;

  /** Two-phase webhook claim — abort. DELETE pending row on sessions.create
   *  failure so a retry can re-claim. */
  releasePending(publicationId: string, issueId: string): Promise<void>;
}
