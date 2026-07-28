import { eq } from "drizzle-orm";
import {
  asBuilder,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { slack_apps } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  AppCredentials,
  AppRepo,
  Crypto,
  IdGenerator,
  NewAppCredentials,
} from "@open-managed-agents/integrations-core";

/**
 * SQL app repo for Slack. Mirrors SqlLinearAppRepo but uses `slack_apps` and stores
 * the per-App signing secret (not a per-webhook secret — Slack's signing
 * secret is one value per App used for ALL events). The base AppRepo
 * interface calls this slot `webhookSecret`/`getWebhookSecret`; semantically
 * for Slack it's the signing secret. Same shape, different name.
 */
export class SqlSlackAppRepo implements AppRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly crypto: Crypto,
    private readonly ids: IdGenerator,
  ) {
    this.db = asBuilder(db);
  }

  async get(id: string): Promise<AppCredentials | null> {
    const row = await getOne<typeof slack_apps.$inferSelect>(
      this.db.select().from(slack_apps).where(eq(slack_apps.id, id)),
    );
    return row ? this.toDomain(row) : null;
  }

  async getByPublication(publicationId: string): Promise<AppCredentials | null> {
    const row = await getOne<typeof slack_apps.$inferSelect>(
      this.db
        .select()
        .from(slack_apps)
        .where(eq(slack_apps.publication_id, publicationId)),
    );
    return row ? this.toDomain(row) : null;
  }

  async getWebhookSecret(id: string): Promise<string | null> {
    const row = await getOne<{ signing_secret_cipher: string }>(
      this.db
        .select({ signing_secret_cipher: slack_apps.signing_secret_cipher })
        .from(slack_apps)
        .where(eq(slack_apps.id, id)),
    );
    if (!row) return null;
    return this.crypto.decrypt(row.signing_secret_cipher);
  }

  async getClientSecret(id: string): Promise<string | null> {
    const row = await getOne<{ client_secret_cipher: string }>(
      this.db
        .select({ client_secret_cipher: slack_apps.client_secret_cipher })
        .from(slack_apps)
        .where(eq(slack_apps.id, id)),
    );
    if (!row) return null;
    return this.crypto.decrypt(row.client_secret_cipher);
  }

  async insert(row: NewAppCredentials): Promise<AppCredentials> {
    const id = row.id ?? this.ids.generate();
    const now = Date.now();
    const clientSecretCipher = await this.crypto.encrypt(row.clientSecret);
    const signingSecretCipher = await this.crypto.encrypt(row.webhookSecret);
    // Upsert on PK: callers may retry installs and we don't want stale
    // secrets if they re-bootstrap with new values.
    await runOnce(
      this.db
        .insert(slack_apps)
        .values({
          id,
          tenant_id: row.tenantId,
          publication_id: row.publicationId,
          client_id: row.clientId,
          client_secret_cipher: clientSecretCipher,
          signing_secret_cipher: signingSecretCipher,
          created_at: now,
        })
        .onConflictDoUpdate({
          target: slack_apps.id,
          set: {
            client_id: row.clientId,
            client_secret_cipher: clientSecretCipher,
            signing_secret_cipher: signingSecretCipher,
          },
        }),
    );
    return {
      id,
      tenantId: row.tenantId,
      publicationId: row.publicationId,
      clientId: row.clientId,
      clientSecretCipher,
      webhookSecretCipher: signingSecretCipher,
      createdAt: now,
    };
  }

  async setPublicationId(id: string, publicationId: string): Promise<void> {
    await runOnce(
      this.db
        .update(slack_apps)
        .set({ publication_id: publicationId })
        .where(eq(slack_apps.id, id)),
    );
  }

  async delete(id: string): Promise<void> {
    await runOnce(
      this.db.delete(slack_apps).where(eq(slack_apps.id, id)),
    );
  }

  private toDomain(row: typeof slack_apps.$inferSelect): AppCredentials {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      clientId: row.client_id,
      clientSecretCipher: row.client_secret_cipher,
      webhookSecretCipher: row.signing_secret_cipher,
      createdAt: row.created_at,
    };
  }
}
