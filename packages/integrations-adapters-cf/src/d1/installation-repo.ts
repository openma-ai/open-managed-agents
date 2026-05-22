import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { linear_installations } from "@open-managed-agents/db-schema/cf-integrations";
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
 * SQL installation repo for Linear. Targets `linear_installations`. Mirrors
 * the github/slack shape via the OmaDb port — same dialect-blind code on CF
 * D1 and Node-PG / Node-SQLite.
 */
export class SqlLinearInstallationRepo implements InstallationRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly crypto: Crypto,
    private readonly ids: IdGenerator,
  ) {
    this.db = asBuilder(db);
  }

  async get(id: string): Promise<Installation | null> {
    const row = await getOne<typeof linear_installations.$inferSelect>(
      this.db
        .select()
        .from(linear_installations)
        .where(eq(linear_installations.id, id)),
    );
    return row ? this.toDomain(row) : null;
  }

  async findByWorkspace(
    providerId: ProviderId,
    workspaceId: WorkspaceId,
    installKind: InstallKind,
    appId: string | null,
  ): Promise<Installation | null> {
    const row = await getOne<typeof linear_installations.$inferSelect>(
      this.db
        .select()
        .from(linear_installations)
        .where(
          and(
            eq(linear_installations.provider_id, providerId),
            eq(linear_installations.workspace_id, workspaceId),
            eq(linear_installations.install_kind, installKind),
            // COALESCE comparison preserves the existing semantics for nullable app_id
            sql`COALESCE(${linear_installations.app_id}, '') = COALESCE(${appId}, '')`,
            isNull(linear_installations.revoked_at),
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
    const rows = await getAll<typeof linear_installations.$inferSelect>(
      this.db
        .select()
        .from(linear_installations)
        .where(
          and(
            eq(linear_installations.user_id, userId),
            eq(linear_installations.provider_id, providerId),
            isNull(linear_installations.revoked_at),
          ),
        )
        .orderBy(desc(linear_installations.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async getAccessToken(id: string): Promise<string | null> {
    const row = await getOne<{ access_token_cipher: string }>(
      this.db
        .select({ access_token_cipher: linear_installations.access_token_cipher })
        .from(linear_installations)
        .where(
          and(
            eq(linear_installations.id, id),
            isNull(linear_installations.revoked_at),
          ),
        ),
    );
    if (!row) return null;
    return this.crypto.decrypt(row.access_token_cipher);
  }

  async getRefreshToken(id: string): Promise<string | null> {
    const row = await getOne<{ refresh_token_cipher: string | null }>(
      this.db
        .select({ refresh_token_cipher: linear_installations.refresh_token_cipher })
        .from(linear_installations)
        .where(
          and(
            eq(linear_installations.id, id),
            isNull(linear_installations.revoked_at),
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
      // Leave the existing refresh row untouched. Linear actually rotates the
      // refresh token on every refresh — callers should pass it through — so
      // this branch only fires when upstream genuinely omitted it.
      await runOnce(
        this.db
          .update(linear_installations)
          .set({ access_token_cipher: accessCipher })
          .where(eq(linear_installations.id, id)),
      );
      return;
    }
    const refreshCipher = await this.crypto.encrypt(refreshToken);
    await runOnce(
      this.db
        .update(linear_installations)
        .set({
          access_token_cipher: accessCipher,
          refresh_token_cipher: refreshCipher,
        })
        .where(eq(linear_installations.id, id)),
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
      this.db.insert(linear_installations).values({
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
        .update(linear_installations)
        .set({ vault_id: vaultId })
        .where(eq(linear_installations.id, id)),
    );
  }

  async markRevoked(id: string, at: number): Promise<void> {
    await runOnce(
      this.db
        .update(linear_installations)
        .set({ revoked_at: at })
        .where(eq(linear_installations.id, id)),
    );
  }

  private toDomain(row: typeof linear_installations.$inferSelect): Installation {
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
