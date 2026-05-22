import { eq } from "drizzle-orm";
import {
  asBuilder,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { linear_apps } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  AppCredentials,
  AppRepo,
  Crypto,
  IdGenerator,
  NewAppCredentials,
} from "@open-managed-agents/integrations-core";

/**
 * SQL app repo for Linear. Targets `linear_apps`. Stores per-publication
 * Linear App credentials (legacy A1 install flow); the publication-first
 * flow stores credentials directly on the linear_publications row, but
 * existing rows still live here.
 */
export class SqlLinearAppRepo implements AppRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly crypto: Crypto,
    private readonly ids: IdGenerator,
  ) {
    this.db = asBuilder(db);
  }

  async get(id: string): Promise<AppCredentials | null> {
    const row = await getOne<typeof linear_apps.$inferSelect>(
      this.db.select().from(linear_apps).where(eq(linear_apps.id, id)),
    );
    return row ? this.toDomain(row) : null;
  }

  async getByPublication(publicationId: string): Promise<AppCredentials | null> {
    const row = await getOne<typeof linear_apps.$inferSelect>(
      this.db
        .select()
        .from(linear_apps)
        .where(eq(linear_apps.publication_id, publicationId)),
    );
    return row ? this.toDomain(row) : null;
  }

  async getWebhookSecret(id: string): Promise<string | null> {
    const row = await getOne<{ webhook_secret_cipher: string }>(
      this.db
        .select({ webhook_secret_cipher: linear_apps.webhook_secret_cipher })
        .from(linear_apps)
        .where(eq(linear_apps.id, id)),
    );
    if (!row) return null;
    return this.crypto.decrypt(row.webhook_secret_cipher);
  }

  async getClientSecret(id: string): Promise<string | null> {
    const row = await getOne<{ client_secret_cipher: string }>(
      this.db
        .select({ client_secret_cipher: linear_apps.client_secret_cipher })
        .from(linear_apps)
        .where(eq(linear_apps.id, id)),
    );
    if (!row) return null;
    return this.crypto.decrypt(row.client_secret_cipher);
  }

  async insert(row: NewAppCredentials): Promise<AppCredentials> {
    const id = row.id ?? this.ids.generate();
    const now = Date.now();
    const clientSecretCipher = await this.crypto.encrypt(row.clientSecret);
    const webhookSecretCipher = await this.crypto.encrypt(row.webhookSecret);
    // Upsert: when the same id is re-submitted (e.g. user re-pastes credentials
    // for the same App in the publish wizard), refresh the credentials in
    // place rather than failing on PRIMARY KEY conflict. created_at and
    // publication_id are preserved (publication_id is set later via
    // setPublicationId, after OAuth completes). tenant_id is also preserved
    // on conflict — re-submits should not silently re-tenant a row.
    await runOnce(
      this.db
        .insert(linear_apps)
        .values({
          id,
          tenant_id: row.tenantId,
          publication_id: row.publicationId,
          client_id: row.clientId,
          client_secret_cipher: clientSecretCipher,
          webhook_secret_cipher: webhookSecretCipher,
          created_at: now,
        })
        .onConflictDoUpdate({
          target: linear_apps.id,
          set: {
            client_id: row.clientId,
            client_secret_cipher: clientSecretCipher,
            webhook_secret_cipher: webhookSecretCipher,
          },
        }),
    );
    return {
      id,
      tenantId: row.tenantId,
      publicationId: row.publicationId,
      clientId: row.clientId,
      clientSecretCipher,
      webhookSecretCipher,
      createdAt: now,
    };
  }

  async setPublicationId(id: string, publicationId: string): Promise<void> {
    await runOnce(
      this.db
        .update(linear_apps)
        .set({ publication_id: publicationId })
        .where(eq(linear_apps.id, id)),
    );
  }

  async delete(id: string): Promise<void> {
    await runOnce(this.db.delete(linear_apps).where(eq(linear_apps.id, id)));
  }

  private toDomain(row: typeof linear_apps.$inferSelect): AppCredentials {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      clientId: row.client_id,
      clientSecretCipher: row.client_secret_cipher,
      webhookSecretCipher: row.webhook_secret_cipher,
      createdAt: row.created_at,
    };
  }
}
