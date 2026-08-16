// SQL installation repo for Feishu (D1 / SQLite).
//
// Mirrors packages/integrations-adapters-cf/src/d1/slack/installation-repo.ts
// but adapted for Feishu's auth model: tenant_access_token (cached, 2h TTL)
// instead of bot/user dual tokens; no user_token_cipher / bot_vault_id.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { feishu_installations } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  Crypto,
  IdGenerator,
  Installation,
  InstallKind,
  NewInstallation,
  ProviderId,
  WorkspaceId,
} from "@open-managed-agents/integrations-core";
import type { FeishuInstallationRepo } from "@open-managed-agents/feishu";

export class SqlFeishuInstallationRepo implements FeishuInstallationRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly crypto: Crypto,
    private readonly ids: IdGenerator,
  ) {
    this.db = asBuilder(db);
  }

  async get(id: string): Promise<Installation | null> {
    const row = await getOne<typeof feishu_installations.$inferSelect>(
      this.db.select().from(feishu_installations).where(eq(feishu_installations.id, id)),
    );
    return row ? this.toDomain(row) : null;
  }

  async findByWorkspace(
    providerId: ProviderId,
    workspaceId: WorkspaceId,
    installKind: InstallKind,
    appId: string | null,
  ): Promise<Installation | null> {
    const row = await getOne<typeof feishu_installations.$inferSelect>(
      this.db
        .select()
        .from(feishu_installations)
        .where(
          and(
            eq(feishu_installations.provider_id, providerId),
            eq(feishu_installations.workspace_id, workspaceId),
            eq(feishu_installations.install_kind, installKind),
            sql`COALESCE(${feishu_installations.app_id}, '') = COALESCE(${appId}, '')`,
            isNull(feishu_installations.revoked_at),
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
    const rows = await getAll<typeof feishu_installations.$inferSelect>(
      this.db
        .select()
        .from(feishu_installations)
        .where(
          and(
            eq(feishu_installations.user_id, userId),
            eq(feishu_installations.provider_id, providerId),
            isNull(feishu_installations.revoked_at),
          ),
        )
        .orderBy(desc(feishu_installations.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async getAccessToken(id: string): Promise<string | null> {
    return this.getTenantAccessToken(id);
  }

  async getRefreshToken(_id: string): Promise<string | null> {
    // Feishu tenant_access_token is renewed via the auth endpoint, not via
    // a refresh_token. The WS runner calls refreshTenantAccessToken instead.
    return null;
  }

  async setTokens(_id: string, _accessToken: string, _refreshToken: string | null): Promise<void> {
    throw new Error(
      "SqlFeishuInstallationRepo.setTokens: tenant_access_token rotation goes through setTenantAccessToken",
    );
  }

  async getTenantAccessToken(id: string): Promise<string | null> {
    const row = await getOne<{
      tenant_access_token_cipher: string;
      expires_at: number;
      revoked_at: number | null;
    }>(
      this.db
        .select({
          tenant_access_token_cipher: feishu_installations.tenant_access_token_cipher,
          expires_at: feishu_installations.expires_at,
          revoked_at: feishu_installations.revoked_at,
        })
        .from(feishu_installations)
        .where(eq(feishu_installations.id, id)),
    );
    if (!row || row.revoked_at !== null) return null;
    return this.crypto.decrypt(row.tenant_access_token_cipher);
  }

  async setTenantAccessToken(
    id: string,
    accessToken: string,
    expiresAt: number,
  ): Promise<void> {
    const cipher = await this.crypto.encrypt(accessToken);
    await runOnce(
      this.db
        .update(feishu_installations)
        .set({
          tenant_access_token_cipher: cipher,
          expires_at: expiresAt,
        })
        .where(eq(feishu_installations.id, id)),
    );
  }

  async findByAppId(appId: string): Promise<Installation | null> {
    const row = await getOne<typeof feishu_installations.$inferSelect>(
      this.db
        .select()
        .from(feishu_installations)
        .where(
          and(
            eq(feishu_installations.app_id, appId),
            isNull(feishu_installations.revoked_at),
          ),
        )
        .limit(1),
    );
    return row ? this.toDomain(row) : null;
  }

  async insert(row: NewInstallation): Promise<Installation> {
    const id = this.ids.generate();
    const now = Date.now();
    // Feishu tenant_access_token is created lazily — the WS runner mints it
    // on first connect. Insert a placeholder cipher (empty string + far-future
    // expiry) so the NOT NULL constraints don't fail; the runner overwrites
    // these via setTenantAccessToken.
    const placeholderCipher = await this.crypto.encrypt("");
    await runOnce(
      this.db.insert(feishu_installations).values({
        id,
        tenant_id: row.tenantId,
        user_id: row.userId,
        provider_id: row.providerId,
        workspace_id: row.workspaceId,
        workspace_name: row.workspaceName,
        install_kind: row.installKind,
        app_id: row.appId,
        tenant_access_token_cipher: placeholderCipher,
        expires_at: 0,
        scopes: JSON.stringify(row.scopes),
        bot_open_id: null,
        vault_id: null,
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
      // Installation.botUserId is required; Feishu identifies the bot as the
      // app_id. We mirror appId into botUserId so downstream code that walks
      // the Installation contract uniformly can still render an identity.
      botUserId: row.appId ?? "",
      scopes: row.scopes,
      vaultId: null,
      createdAt: now,
      revokedAt: null,
    };
  }

  async setVaultId(id: string, vaultId: string): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_installations)
        .set({ vault_id: vaultId })
        .where(eq(feishu_installations.id, id)),
    );
  }

  async markRevoked(id: string, at: number): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_installations)
        .set({ revoked_at: at })
        .where(eq(feishu_installations.id, id)),
    );
  }

  private toDomain(row: typeof feishu_installations.$inferSelect): Installation {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      providerId: row.provider_id as ProviderId,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      installKind: row.install_kind as InstallKind,
      appId: row.app_id,
      botUserId: row.app_id ?? "",
      scopes: JSON.parse(row.scopes) as string[],
      vaultId: row.vault_id,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }
}
