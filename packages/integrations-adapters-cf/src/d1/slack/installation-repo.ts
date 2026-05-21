import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { slack_installations } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  Crypto,
  IdGenerator,
  Installation,
  InstallKind,
  NewInstallation,
  ProviderId,
  WorkspaceId,
} from "@open-managed-agents/integrations-core";
import type { SlackInstallationRepo } from "@open-managed-agents/slack";

/**
 * SQL installation repo for Slack. Mirrors SqlLinearInstallationRepo but uses
 * `slack_installations` and adds two Slack-only fields: `user_token_cipher`
 * (xoxp- token for mcp.slack.com) and `bot_vault_id` (vault for direct
 * slack.com/api calls). Implements the SlackInstallationRepo extension.
 */
export class SqlSlackInstallationRepo implements SlackInstallationRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly crypto: Crypto,
    private readonly ids: IdGenerator,
  ) {
    this.db = asBuilder(db);
  }

  async get(id: string): Promise<Installation | null> {
    const row = await getOne<typeof slack_installations.$inferSelect>(
      this.db.select().from(slack_installations).where(eq(slack_installations.id, id)),
    );
    return row ? this.toDomain(row) : null;
  }

  async findByWorkspace(
    providerId: ProviderId,
    workspaceId: WorkspaceId,
    installKind: InstallKind,
    appId: string | null,
  ): Promise<Installation | null> {
    const row = await getOne<typeof slack_installations.$inferSelect>(
      this.db
        .select()
        .from(slack_installations)
        .where(
          and(
            eq(slack_installations.provider_id, providerId),
            eq(slack_installations.workspace_id, workspaceId),
            eq(slack_installations.install_kind, installKind),
            // COALESCE comparison preserves the existing semantics for nullable app_id
            sql`COALESCE(${slack_installations.app_id}, '') = COALESCE(${appId}, '')`,
            isNull(slack_installations.revoked_at),
          ),
        )
        .limit(1),
    );
    return row ? this.toDomain(row) : null;
  }

  async listByUser(
    userId: string,
    providerId: ProviderId,
  ): Promise<readonly Installation[]> {
    const rows = await getAll<typeof slack_installations.$inferSelect>(
      this.db
        .select()
        .from(slack_installations)
        .where(
          and(
            eq(slack_installations.user_id, userId),
            eq(slack_installations.provider_id, providerId),
            isNull(slack_installations.revoked_at),
          ),
        )
        .orderBy(desc(slack_installations.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async getAccessToken(id: string): Promise<string | null> {
    const row = await getOne<{ access_token_cipher: string }>(
      this.db
        .select({ access_token_cipher: slack_installations.access_token_cipher })
        .from(slack_installations)
        .where(
          and(
            eq(slack_installations.id, id),
            isNull(slack_installations.revoked_at),
          ),
        ),
    );
    if (!row) return null;
    return this.crypto.decrypt(row.access_token_cipher);
  }

  async getUserToken(id: string): Promise<string | null> {
    const row = await getOne<{ user_token_cipher: string | null }>(
      this.db
        .select({ user_token_cipher: slack_installations.user_token_cipher })
        .from(slack_installations)
        .where(
          and(
            eq(slack_installations.id, id),
            isNull(slack_installations.revoked_at),
          ),
        ),
    );
    if (!row || !row.user_token_cipher) return null;
    return this.crypto.decrypt(row.user_token_cipher);
  }

  /**
   * Slack xoxb-/xoxp- tokens are long-lived by default; rotation requires the
   * workspace to opt in to Token Rotation (we don't yet store refresh_token
   * for that path — see migration 0006). Always returns null.
   */
  async getRefreshToken(_id: string): Promise<string | null> {
    return null;
  }

  /**
   * Stub for the shared InstallationRepo contract. Slack doesn't rotate the
   * primary bot token via this path; if Token Rotation is added later, this
   * will land here. Throws to make accidental callers loud.
   */
  async setTokens(_id: string, _accessToken: string, _refreshToken: string | null): Promise<void> {
    throw new Error(
      "SqlSlackInstallationRepo.setTokens: Slack tokens are long-lived; rotation not yet supported",
    );
  }

  async insert(row: NewInstallation): Promise<Installation> {
    const id = this.ids.generate();
    const now = Date.now();
    const accessTokenCipher = await this.crypto.encrypt(row.accessToken);
    // Slack xoxb- tokens are long-lived by default; refresh-token rotation is
    // an opt-in workspace setting we don't yet support. NewInstallation.refreshToken
    // (a shared port field) is intentionally ignored here.
    await runOnce(
      this.db.insert(slack_installations).values({
        id,
        tenant_id: row.tenantId,
        user_id: row.userId,
        provider_id: row.providerId,
        workspace_id: row.workspaceId,
        workspace_name: row.workspaceName,
        install_kind: row.installKind,
        app_id: row.appId,
        access_token_cipher: accessTokenCipher,
        user_token_cipher: null,
        scopes: JSON.stringify(row.scopes),
        bot_user_id: row.botUserId,
        created_at: now,
        revoked_at: null,
      }),
    );
    return {
      id,
      tenantId: row.tenantId,
      userId: row.userId,
      providerId: row.providerId,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      installKind: row.installKind,
      appId: row.appId,
      botUserId: row.botUserId,
      scopes: row.scopes,
      vaultId: null,
      createdAt: now,
      revokedAt: null,
    };
  }

  async setUserToken(id: string, userToken: string): Promise<void> {
    const cipher = await this.crypto.encrypt(userToken);
    await runOnce(
      this.db
        .update(slack_installations)
        .set({ user_token_cipher: cipher })
        .where(eq(slack_installations.id, id)),
    );
  }

  async setVaultId(id: string, vaultId: string): Promise<void> {
    await runOnce(
      this.db
        .update(slack_installations)
        .set({ vault_id: vaultId })
        .where(eq(slack_installations.id, id)),
    );
  }

  async setBotVaultId(id: string, botVaultId: string): Promise<void> {
    await runOnce(
      this.db
        .update(slack_installations)
        .set({ bot_vault_id: botVaultId })
        .where(eq(slack_installations.id, id)),
    );
  }

  async getBotVaultId(id: string): Promise<string | null> {
    const row = await getOne<{ bot_vault_id: string | null }>(
      this.db
        .select({ bot_vault_id: slack_installations.bot_vault_id })
        .from(slack_installations)
        .where(eq(slack_installations.id, id)),
    );
    return row?.bot_vault_id ?? null;
  }

  async markRevoked(id: string, at: number): Promise<void> {
    await runOnce(
      this.db
        .update(slack_installations)
        .set({ revoked_at: at })
        .where(eq(slack_installations.id, id)),
    );
  }

  private toDomain(row: typeof slack_installations.$inferSelect): Installation {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      providerId: row.provider_id as ProviderId,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      installKind: row.install_kind as InstallKind,
      appId: row.app_id,
      botUserId: row.bot_user_id,
      scopes: JSON.parse(row.scopes) as string[],
      vaultId: row.vault_id,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }
}
