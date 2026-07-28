import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { github_installations } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  Crypto,
  IdGenerator,
  Installation,
  InstallationRepo,
  InstallKind,
  NewInstallation,
  ProviderId,
  WorkspaceId,
} from "@open-managed-agents/integrations-core";

/**
 * SQL installation repo for GitHub. Mirrors the linear/slack shape but
 * targets `github_installations`. Split out so reverse-lookup methods like
 * listByUser don't bleed across providers (the previous shared-table layout
 * required filtering by provider_id everywhere and broke listByUserAndAgent
 * for the per-provider AgentDetail folds).
 */
export class SqlGitHubInstallationRepo implements InstallationRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly crypto: Crypto,
    private readonly ids: IdGenerator,
  ) {
    this.db = asBuilder(db);
  }

  async get(id: string): Promise<Installation | null> {
    const row = await getOne<typeof github_installations.$inferSelect>(
      this.db
        .select()
        .from(github_installations)
        .where(eq(github_installations.id, id)),
    );
    return row ? this.toDomain(row) : null;
  }

  async findByWorkspace(
    providerId: ProviderId,
    workspaceId: WorkspaceId,
    installKind: InstallKind,
    appId: string | null,
  ): Promise<Installation | null> {
    const row = await getOne<typeof github_installations.$inferSelect>(
      this.db
        .select()
        .from(github_installations)
        .where(
          and(
            eq(github_installations.provider_id, providerId),
            eq(github_installations.workspace_id, workspaceId),
            eq(github_installations.install_kind, installKind),
            // COALESCE comparison preserves the existing semantics for nullable app_id
            sql`COALESCE(${github_installations.app_id}, '') = COALESCE(${appId}, '')`,
            isNull(github_installations.revoked_at),
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
    const rows = await getAll<typeof github_installations.$inferSelect>(
      this.db
        .select()
        .from(github_installations)
        .where(
          and(
            eq(github_installations.user_id, userId),
            eq(github_installations.provider_id, providerId),
            isNull(github_installations.revoked_at),
          ),
        )
        .orderBy(desc(github_installations.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async getAccessToken(id: string): Promise<string | null> {
    const row = await getOne<{ access_token_cipher: string }>(
      this.db
        .select({ access_token_cipher: github_installations.access_token_cipher })
        .from(github_installations)
        .where(
          and(
            eq(github_installations.id, id),
            isNull(github_installations.revoked_at),
          ),
        ),
    );
    if (!row) return null;
    return this.crypto.decrypt(row.access_token_cipher);
  }

  async getRefreshToken(id: string): Promise<string | null> {
    const row = await getOne<{ refresh_token_cipher: string | null }>(
      this.db
        .select({ refresh_token_cipher: github_installations.refresh_token_cipher })
        .from(github_installations)
        .where(
          and(
            eq(github_installations.id, id),
            isNull(github_installations.revoked_at),
          ),
        ),
    );
    if (!row || !row.refresh_token_cipher) return null;
    return this.crypto.decrypt(row.refresh_token_cipher);
  }

  async setTokens(
    id: string,
    accessToken: string,
    refreshToken: string | null,
  ): Promise<void> {
    const accessCipher = await this.crypto.encrypt(accessToken);
    if (refreshToken === null) {
      await runOnce(
        this.db
          .update(github_installations)
          .set({ access_token_cipher: accessCipher })
          .where(eq(github_installations.id, id)),
      );
      return;
    }
    const refreshCipher = await this.crypto.encrypt(refreshToken);
    await runOnce(
      this.db
        .update(github_installations)
        .set({
          access_token_cipher: accessCipher,
          refresh_token_cipher: refreshCipher,
        })
        .where(eq(github_installations.id, id)),
    );
  }

  async insert(row: NewInstallation): Promise<Installation> {
    const id = this.ids.generate();
    const now = Date.now();
    const accessTokenCipher = await this.crypto.encrypt(row.accessToken);
    const refreshTokenCipher = row.refreshToken
      ? await this.crypto.encrypt(row.refreshToken)
      : null;
    await runOnce(
      this.db.insert(github_installations).values({
        id,
        tenant_id: row.tenantId,
        user_id: row.userId,
        provider_id: row.providerId,
        workspace_id: row.workspaceId,
        workspace_name: row.workspaceName,
        install_kind: row.installKind,
        app_id: row.appId,
        access_token_cipher: accessTokenCipher,
        refresh_token_cipher: refreshTokenCipher,
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

  async setVaultId(id: string, vaultId: string): Promise<void> {
    await runOnce(
      this.db
        .update(github_installations)
        .set({ vault_id: vaultId })
        .where(eq(github_installations.id, id)),
    );
  }

  async markRevoked(id: string, at: number): Promise<void> {
    await runOnce(
      this.db
        .update(github_installations)
        .set({ revoked_at: at })
        .where(eq(github_installations.id, id)),
    );
  }

  private toDomain(row: typeof github_installations.$inferSelect): Installation {
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
