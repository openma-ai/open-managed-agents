import { eq } from "drizzle-orm";
import {
  asBuilder,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { github_apps } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  Crypto,
  GitHubAppCredentials,
  GitHubAppRepo,
  IdGenerator,
  NewGitHubAppCredentials,
} from "@open-managed-agents/integrations-core";

/**
 * SQL app repo for GitHub. Targets `github_apps`. Stores the per-publication
 * GitHub App credentials. webhook_secret + private_key are AES-GCM encrypted;
 * client_id / app_id / app_slug / bot_login are plaintext (public-ish
 * identifiers). client_secret is encrypted but optional (older Apps without
 * "Request user authorization (OAuth)" turned on don't have one).
 */
export class SqlGitHubAppRepo implements GitHubAppRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly crypto: Crypto,
    private readonly ids: IdGenerator,
  ) {
    this.db = asBuilder(db);
  }

  async get(id: string): Promise<GitHubAppCredentials | null> {
    const row = await getOne<typeof github_apps.$inferSelect>(
      this.db.select().from(github_apps).where(eq(github_apps.id, id)),
    );
    return row ? this.toDomain(row) : null;
  }

  async getByPublication(publicationId: string): Promise<GitHubAppCredentials | null> {
    const row = await getOne<typeof github_apps.$inferSelect>(
      this.db
        .select()
        .from(github_apps)
        .where(eq(github_apps.publication_id, publicationId)),
    );
    return row ? this.toDomain(row) : null;
  }

  async getByAppId(appId: string): Promise<GitHubAppCredentials | null> {
    const row = await getOne<typeof github_apps.$inferSelect>(
      this.db
        .select()
        .from(github_apps)
        .where(eq(github_apps.app_id, appId))
        .limit(1),
    );
    return row ? this.toDomain(row) : null;
  }

  async getWebhookSecret(id: string): Promise<string | null> {
    const row = await getOne<{ webhook_secret_cipher: string }>(
      this.db
        .select({ webhook_secret_cipher: github_apps.webhook_secret_cipher })
        .from(github_apps)
        .where(eq(github_apps.id, id)),
    );
    if (!row) return null;
    return this.crypto.decrypt(row.webhook_secret_cipher);
  }

  async getClientSecret(id: string): Promise<string | null> {
    const row = await getOne<{ client_secret_cipher: string | null }>(
      this.db
        .select({ client_secret_cipher: github_apps.client_secret_cipher })
        .from(github_apps)
        .where(eq(github_apps.id, id)),
    );
    if (!row || row.client_secret_cipher == null) return null;
    return this.crypto.decrypt(row.client_secret_cipher);
  }

  async getPrivateKey(id: string): Promise<string | null> {
    const row = await getOne<{ private_key_cipher: string }>(
      this.db
        .select({ private_key_cipher: github_apps.private_key_cipher })
        .from(github_apps)
        .where(eq(github_apps.id, id)),
    );
    if (!row) return null;
    return this.crypto.decrypt(row.private_key_cipher);
  }

  async insert(row: NewGitHubAppCredentials): Promise<GitHubAppCredentials> {
    const id = row.id ?? this.ids.generate();
    const now = Date.now();
    const clientSecretCipher =
      row.clientSecret == null ? null : await this.crypto.encrypt(row.clientSecret);
    const webhookSecretCipher = await this.crypto.encrypt(row.webhookSecret);
    const privateKeyCipher = await this.crypto.encrypt(row.privateKey);
    // Upsert: a re-submit of the publish form (e.g. user pasted wrong key,
    // tries again with the same formToken) refreshes credentials in place
    // rather than failing on PRIMARY KEY conflict. publication_id, tenant_id
    // and created_at are preserved.
    await runOnce(
      this.db
        .insert(github_apps)
        .values({
          id,
          tenant_id: row.tenantId,
          publication_id: row.publicationId,
          app_id: row.appId,
          app_slug: row.appSlug,
          bot_login: row.botLogin,
          client_id: row.clientId,
          client_secret_cipher: clientSecretCipher,
          webhook_secret_cipher: webhookSecretCipher,
          private_key_cipher: privateKeyCipher,
          created_at: now,
        })
        .onConflictDoUpdate({
          target: github_apps.id,
          set: {
            app_id: row.appId,
            app_slug: row.appSlug,
            bot_login: row.botLogin,
            client_id: row.clientId,
            client_secret_cipher: clientSecretCipher,
            webhook_secret_cipher: webhookSecretCipher,
            private_key_cipher: privateKeyCipher,
          },
        }),
    );
    return {
      id,
      tenantId: row.tenantId,
      publicationId: row.publicationId,
      appId: row.appId,
      appSlug: row.appSlug,
      botLogin: row.botLogin,
      clientId: row.clientId,
      clientSecretCipher,
      webhookSecretCipher,
      privateKeyCipher,
      createdAt: now,
    };
  }

  async setPublicationId(id: string, publicationId: string): Promise<void> {
    await runOnce(
      this.db
        .update(github_apps)
        .set({ publication_id: publicationId })
        .where(eq(github_apps.id, id)),
    );
  }

  async delete(id: string): Promise<void> {
    await runOnce(this.db.delete(github_apps).where(eq(github_apps.id, id)));
  }

  private toDomain(row: typeof github_apps.$inferSelect): GitHubAppCredentials {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      appId: row.app_id,
      appSlug: row.app_slug,
      botLogin: row.bot_login,
      clientId: row.client_id,
      clientSecretCipher: row.client_secret_cipher,
      webhookSecretCipher: row.webhook_secret_cipher,
      privateKeyCipher: row.private_key_cipher,
      createdAt: row.created_at,
    };
  }
}
