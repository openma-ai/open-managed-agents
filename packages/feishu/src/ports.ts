// Feishu-specific port extensions.
//
// Mirrors packages/slack/src/ports.ts but adapted for Feishu's auth model:
//   - tenant_access_token (cached, 2h TTL) instead of bot/user dual tokens
//   - App credentials live directly on feishu_publications (publication-first)
//   - No user-token vault binding — the install's bot identity IS the App

import type {
  InstallationRepo,
  PublicationRepo,
  SessionScopeRepo,
  CapabilitySet,
  CapabilityKey,
  Publication,
  SessionGranularity,
} from "@open-managed-agents/integrations-core";

export interface FeishuInstallationRepo extends InstallationRepo {
  /**
   * Returns the decrypted tenant_access_token, or null if revoked. The
   * runner/handler refreshes on 401 via `setTokens`.
   */
  getTenantAccessToken(id: string): Promise<string | null>;

  /**
   * Cache a freshly-minted tenant_access_token + its expiry. Called by the
   * runner after a `auth.v3.tenant_access_token.internal` round-trip or on
   * refresh-on-401.
   */
  setTenantAccessToken(
    id: string,
    accessToken: string,
    expiresAt: number,
  ): Promise<void>;

  /** Look up by Feishu's app_id (cli_…). Used by the WS runner boot. */
  findByAppId(appId: string): Promise<import("@open-managed-agents/integrations-core").Installation | null>;
}

/**
 * Publication-first install state stored on each `feishu_publications` row.
 *
 * Lifecycle (same as slack):
 *   pending_setup       — shell-created, no creds.
 *   credentials_filled  — app_id + 4 cipher columns set; ready for tenant-bind.
 *   awaiting_install    — admin redirected to Feishu's app config; waiting
 *                          for WS test-ping.
 *   live                — WS runner confirmed handshake; installation +
 *                          vault bound; status flipped.
 */
export interface FeishuPublicationCredentialState {
  appId: string | null;
  hasAppSecret: boolean;
  hasVerificationToken: boolean;
  hasEncryptKey: boolean;
}

export interface FeishuPublicationRepo extends PublicationRepo {
  /** Shell create with status='pending_setup'. installation_id="" sentinel. */
  insertShell(input: {
    tenantId: string;
    userId: string;
    agentId: string;
    environmentId: string;
    persona: { name: string; avatarUrl: string | null };
    capabilities: ReadonlySet<CapabilityKey>;
    sessionGranularity: SessionGranularity;
  }): Promise<Publication>;

  /**
   * PATCH encrypted credentials onto a shell publication. Idempotent.
   * Flips status 'pending_setup' → 'credentials_filled'.
   */
  setCredentials(
    publicationId: string,
    input: {
      appId: string;
      appSecretCipher: string;
      verificationTokenCipher: string;
      encryptKeyCipher: string;
    },
  ): Promise<void>;

  /** Retrieve the decrypted app_secret for tenant_access_token minting. */
  getAppSecret(publicationId: string): Promise<string | null>;

  /** Retrieve the decrypted encrypt_key for URL verification HMAC. */
  getEncryptKey(publicationId: string): Promise<string | null>;

  /** Retrieve the decrypted verification_token (legacy signing material). */
  getVerificationToken(publicationId: string): Promise<string | null>;

  /** Read just the credential staging columns. */
  getCredentialState(
    publicationId: string,
  ): Promise<FeishuPublicationCredentialState | null>;

  /**
   * After WS test-ping: bind the just-created installation_id + vault, flip
   * status='live'. Idempotent.
   */
  bindInstallation(input: {
    publicationId: string;
    installationId: string;
  }): Promise<void>;

  /** Look up a publication by Feishu's app_id (cli_…). */
  findByAppId(appId: string): Promise<Publication | null>;
}

export interface FeishuSessionScopeRepo extends SessionScopeRepo {
  /** Update the cached chat display name. */
  updateChatName(
    publicationId: string,
    scopeKey: string,
    chatName: string,
  ): Promise<void>;

  /**
   * Mark every active scope row for a publication as completed when the
   * installation is revoked (tenant_access_token refresh fails permanently).
   */
  closeAllForPublication(publicationId: string): Promise<void>;
}
