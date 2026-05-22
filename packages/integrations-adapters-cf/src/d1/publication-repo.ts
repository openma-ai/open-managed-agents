import { and, desc, eq, inArray } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { linear_publications } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  CapabilityKey,
  CapabilitySet,
  Crypto,
  IdGenerator,
  LinearPublicationRepo,
  NewPublication,
  NewPublicationShell,
  Persona,
  Publication,
  PublicationCredentials,
  PublicationCredentialsInput,
  PublicationMode,
  PublicationStatus,
  SessionGranularity,
} from "@open-managed-agents/integrations-core";

/** Sentinel used for `installation_id` on rows that haven't bound yet. */
const PENDING_INSTALLATION_ID = "";

/**
 * Linear's publication repo. Implements both the base `PublicationRepo`
 * surface (used by routes / dispatch / unpublish) and the Linear-specific
 * publication-first methods (insertShell / setCredentials / bindInstallation
 * / getCredentials / get*Secret).
 *
 * Crypto is required because credentials live on this row now —
 * client_secret, webhook_secret, and (reserved) signing_secret are encrypted
 * via the same Crypto port that token-at-rest uses ("integrations.tokens"
 * label).
 */
export class SqlLinearPublicationRepo implements LinearPublicationRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly ids: IdGenerator,
    /**
     * Optional Crypto port. Required when the publication-first methods are
     * used (setCredentials / getCredentials / get*Secret). The base
     * PublicationRepo methods don't touch it; tests / hosts that wire only
     * legacy install paths can pass undefined.
     */
    private readonly crypto?: Crypto,
  ) {
    this.db = asBuilder(db);
  }

  async get(id: string): Promise<Publication | null> {
    const row = await getOne<typeof linear_publications.$inferSelect>(
      this.db
        .select()
        .from(linear_publications)
        .where(eq(linear_publications.id, id)),
    );
    return row ? this.toDomain(row) : null;
  }

  async listByInstallation(installationId: string): Promise<readonly Publication[]> {
    const rows = await getAll<typeof linear_publications.$inferSelect>(
      this.db
        .select()
        .from(linear_publications)
        .where(eq(linear_publications.installation_id, installationId))
        .orderBy(desc(linear_publications.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async listByUserAndAgent(
    userId: string,
    agentId: string,
  ): Promise<readonly Publication[]> {
    const rows = await getAll<typeof linear_publications.$inferSelect>(
      this.db
        .select()
        .from(linear_publications)
        .where(
          and(
            eq(linear_publications.user_id, userId),
            eq(linear_publications.agent_id, agentId),
          ),
        )
        .orderBy(desc(linear_publications.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async listPendingByUser(userId: string): Promise<readonly Publication[]> {
    const rows = await getAll<typeof linear_publications.$inferSelect>(
      this.db
        .select()
        .from(linear_publications)
        .where(
          and(
            eq(linear_publications.user_id, userId),
            inArray(linear_publications.status, [
              "pending_setup",
              "credentials_filled",
              "awaiting_install",
            ]),
          ),
        )
        .orderBy(desc(linear_publications.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async insert(row: NewPublication): Promise<Publication> {
    const id = this.ids.generate();
    const now = Date.now();
    await runOnce(
      this.db.insert(linear_publications).values({
        id,
        tenant_id: row.tenantId,
        user_id: row.userId,
        agent_id: row.agentId,
        installation_id: row.installationId,
        environment_id: row.environmentId,
        mode: row.mode,
        status: row.status,
        persona_name: row.persona.name,
        // D1 rejects undefined; coerce to null when persona has no avatar.
        persona_avatar_url: row.persona.avatarUrl ?? null,
        capabilities: JSON.stringify([...row.capabilities]),
        session_granularity: row.sessionGranularity,
        created_at: now,
        unpublished_at: null,
      }),
    );
    return {
      id,
      tenantId: row.tenantId,
      userId: row.userId,
      agentId: row.agentId,
      installationId: row.installationId,
      environmentId: row.environmentId,
      mode: row.mode,
      status: row.status,
      persona: row.persona,
      capabilities: row.capabilities,
      sessionGranularity: row.sessionGranularity,
      createdAt: now,
      unpublishedAt: null,
    };
  }

  async insertShell(row: NewPublicationShell): Promise<Publication> {
    const id = this.ids.generate();
    const now = Date.now();
    await runOnce(
      this.db.insert(linear_publications).values({
        id,
        tenant_id: row.tenantId,
        user_id: row.userId,
        agent_id: row.agentId,
        // installation_id stays NOT NULL in the schema; pending pubs get
        // the empty-string sentinel until bindInstallation runs.
        installation_id: PENDING_INSTALLATION_ID,
        environment_id: row.environmentId,
        mode: row.mode,
        status: "pending_setup",
        persona_name: row.persona.name,
        persona_avatar_url: row.persona.avatarUrl ?? null,
        capabilities: JSON.stringify([...row.capabilities]),
        session_granularity: row.sessionGranularity,
        created_at: now,
        unpublished_at: null,
      }),
    );
    return {
      id,
      tenantId: row.tenantId,
      userId: row.userId,
      agentId: row.agentId,
      installationId: PENDING_INSTALLATION_ID,
      environmentId: row.environmentId,
      mode: row.mode,
      status: "pending_setup",
      persona: row.persona,
      capabilities: row.capabilities,
      sessionGranularity: row.sessionGranularity,
      createdAt: now,
      unpublishedAt: null,
    };
  }

  async setCredentials(
    id: string,
    input: PublicationCredentialsInput,
  ): Promise<void> {
    if (!this.crypto) {
      throw new Error(
        "SqlLinearPublicationRepo.setCredentials: Crypto port required for publication-first flow",
      );
    }
    const clientSecretCipher = await this.crypto.encrypt(input.clientSecret);
    const webhookSecretCipher = await this.crypto.encrypt(input.webhookSecret);
    const signingSecretCipher =
      input.signingSecret == null ? null : await this.crypto.encrypt(input.signingSecret);
    await runOnce(
      this.db
        .update(linear_publications)
        .set({
          client_id: input.clientId,
          client_secret_cipher: clientSecretCipher,
          webhook_secret_cipher: webhookSecretCipher,
          signing_secret_cipher: signingSecretCipher,
          status: "awaiting_install",
        })
        .where(eq(linear_publications.id, id)),
    );
  }

  async getCredentials(id: string): Promise<PublicationCredentials | null> {
    if (!this.crypto) return null;
    const row = await getOne<{
      client_id: string | null;
      client_secret_cipher: string | null;
      webhook_secret_cipher: string | null;
      signing_secret_cipher: string | null;
    }>(
      this.db
        .select({
          client_id: linear_publications.client_id,
          client_secret_cipher: linear_publications.client_secret_cipher,
          webhook_secret_cipher: linear_publications.webhook_secret_cipher,
          signing_secret_cipher: linear_publications.signing_secret_cipher,
        })
        .from(linear_publications)
        .where(eq(linear_publications.id, id)),
    );
    if (!row || !row.client_id || !row.client_secret_cipher || !row.webhook_secret_cipher) {
      return null;
    }
    return {
      clientId: row.client_id,
      clientSecret: await this.crypto.decrypt(row.client_secret_cipher),
      webhookSecret: await this.crypto.decrypt(row.webhook_secret_cipher),
      signingSecret: row.signing_secret_cipher
        ? await this.crypto.decrypt(row.signing_secret_cipher)
        : null,
    };
  }

  async getWebhookSecret(id: string): Promise<string | null> {
    if (!this.crypto) return null;
    const row = await getOne<{ webhook_secret_cipher: string | null }>(
      this.db
        .select({ webhook_secret_cipher: linear_publications.webhook_secret_cipher })
        .from(linear_publications)
        .where(eq(linear_publications.id, id)),
    );
    if (!row || !row.webhook_secret_cipher) return null;
    return this.crypto.decrypt(row.webhook_secret_cipher);
  }

  async getClientSecret(id: string): Promise<string | null> {
    if (!this.crypto) return null;
    const row = await getOne<{ client_secret_cipher: string | null }>(
      this.db
        .select({ client_secret_cipher: linear_publications.client_secret_cipher })
        .from(linear_publications)
        .where(eq(linear_publications.id, id)),
    );
    if (!row || !row.client_secret_cipher) return null;
    return this.crypto.decrypt(row.client_secret_cipher);
  }

  async bindInstallation(
    id: string,
    args: { installationId: string; vaultId: string | null },
  ): Promise<void> {
    await runOnce(
      this.db
        .update(linear_publications)
        .set({
          installation_id: args.installationId,
          vault_id: args.vaultId,
          status: "live",
        })
        .where(eq(linear_publications.id, id)),
    );
  }

  async updateStatus(id: string, status: PublicationStatus): Promise<void> {
    await runOnce(
      this.db
        .update(linear_publications)
        .set({ status })
        .where(eq(linear_publications.id, id)),
    );
  }

  async updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void> {
    await runOnce(
      this.db
        .update(linear_publications)
        .set({ capabilities: JSON.stringify([...capabilities]) })
        .where(eq(linear_publications.id, id)),
    );
  }

  async updatePersona(id: string, persona: Persona): Promise<void> {
    await runOnce(
      this.db
        .update(linear_publications)
        .set({
          persona_name: persona.name,
          persona_avatar_url: persona.avatarUrl,
        })
        .where(eq(linear_publications.id, id)),
    );
  }

  async markUnpublished(id: string, at: number): Promise<void> {
    await runOnce(
      this.db
        .update(linear_publications)
        .set({ status: "unpublished", unpublished_at: at })
        .where(eq(linear_publications.id, id)),
    );
  }

  private toDomain(row: typeof linear_publications.$inferSelect): Publication {
    const caps = JSON.parse(row.capabilities) as CapabilityKey[];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      agentId: row.agent_id,
      installationId: row.installation_id,
      environmentId: row.environment_id ?? "",
      mode: row.mode as PublicationMode,
      status: row.status as PublicationStatus,
      persona: { name: row.persona_name, avatarUrl: row.persona_avatar_url },
      capabilities: new Set(caps),
      sessionGranularity: row.session_granularity as SessionGranularity,
      createdAt: row.created_at,
      unpublishedAt: row.unpublished_at,
    };
  }
}
