import { and, desc, eq, inArray } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { slack_publications } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  CapabilityKey,
  CapabilitySet,
  Crypto,
  IdGenerator,
  NewPublication,
  Persona,
  Publication,
  PublicationStatus,
  PublicationMode,
  SessionGranularity,
} from "@open-managed-agents/integrations-core";
import type {
  SlackPublicationRepo,
  SlackPublicationCredentialState,
} from "@open-managed-agents/slack";

export class SqlSlackPublicationRepo implements SlackPublicationRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly ids: IdGenerator,
    private readonly crypto: Crypto,
  ) {
    this.db = asBuilder(db);
  }

  async get(id: string): Promise<Publication | null> {
    const row = await getOne<typeof slack_publications.$inferSelect>(
      this.db
        .select()
        .from(slack_publications)
        .where(eq(slack_publications.id, id)),
    );
    return row ? this.toDomain(row) : null;
  }

  async listByInstallation(installationId: string): Promise<readonly Publication[]> {
    const rows = await getAll<typeof slack_publications.$inferSelect>(
      this.db
        .select()
        .from(slack_publications)
        .where(eq(slack_publications.installation_id, installationId))
        .orderBy(desc(slack_publications.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async listByUserAndAgent(
    userId: string,
    agentId: string,
  ): Promise<readonly Publication[]> {
    const rows = await getAll<typeof slack_publications.$inferSelect>(
      this.db
        .select()
        .from(slack_publications)
        .where(
          and(
            eq(slack_publications.user_id, userId),
            eq(slack_publications.agent_id, agentId),
          ),
        )
        .orderBy(desc(slack_publications.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async listPendingByUser(userId: string): Promise<readonly Publication[]> {
    const rows = await getAll<typeof slack_publications.$inferSelect>(
      this.db
        .select()
        .from(slack_publications)
        .where(
          and(
            eq(slack_publications.user_id, userId),
            inArray(slack_publications.status, [
              "pending_setup",
              "credentials_filled",
              "awaiting_install",
            ]),
          ),
        )
        .orderBy(desc(slack_publications.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async insert(row: NewPublication): Promise<Publication> {
    const id = this.ids.generate();
    const now = Date.now();
    await runOnce(
      this.db.insert(slack_publications).values({
        id,
        tenant_id: row.tenantId,
        user_id: row.userId,
        agent_id: row.agentId,
        installation_id: row.installationId,
        environment_id: row.environmentId,
        mode: row.mode,
        status: row.status,
        persona_name: row.persona.name,
        persona_avatar_url: row.persona.avatarUrl,
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

  // ─── Publication-first credential staging ─────────────────────────────

  async insertShell(input: {
    tenantId: string;
    userId: string;
    agentId: string;
    environmentId: string;
    persona: Persona;
    capabilities: ReadonlySet<CapabilityKey>;
    sessionGranularity: SessionGranularity;
  }): Promise<Publication> {
    return await this.insert({
      tenantId: input.tenantId,
      userId: input.userId,
      agentId: input.agentId,
      // installation_id is NOT NULL on the table; "" sentinel until OAuth
      // completes and bindInstallation flips it to a real id.
      installationId: "",
      environmentId: input.environmentId,
      mode: "full",
      status: "pending_setup",
      persona: input.persona,
      capabilities: input.capabilities,
      sessionGranularity: input.sessionGranularity,
    });
  }

  async setCredentials(
    publicationId: string,
    input: { clientId: string; clientSecretCipher: string; signingSecretCipher: string },
  ): Promise<void> {
    await runOnce(
      this.db
        .update(slack_publications)
        .set({
          client_id: input.clientId,
          client_secret_cipher: input.clientSecretCipher,
          signing_secret_cipher: input.signingSecretCipher,
        })
        .where(eq(slack_publications.id, publicationId)),
    );
  }

  async getClientSecret(publicationId: string): Promise<string | null> {
    const row = await getOne<{ client_secret_cipher: string | null }>(
      this.db
        .select({ client_secret_cipher: slack_publications.client_secret_cipher })
        .from(slack_publications)
        .where(eq(slack_publications.id, publicationId)),
    );
    if (!row?.client_secret_cipher) return null;
    return this.crypto.decrypt(row.client_secret_cipher);
  }

  async getSigningSecret(publicationId: string): Promise<string | null> {
    const row = await getOne<{ signing_secret_cipher: string | null }>(
      this.db
        .select({ signing_secret_cipher: slack_publications.signing_secret_cipher })
        .from(slack_publications)
        .where(eq(slack_publications.id, publicationId)),
    );
    if (!row?.signing_secret_cipher) return null;
    return this.crypto.decrypt(row.signing_secret_cipher);
  }

  async getCredentialState(
    publicationId: string,
  ): Promise<SlackPublicationCredentialState | null> {
    const row = await getOne<{
      client_id: string | null;
      client_secret_cipher: string | null;
      signing_secret_cipher: string | null;
      slack_app_id: string | null;
    }>(
      this.db
        .select({
          client_id: slack_publications.client_id,
          client_secret_cipher: slack_publications.client_secret_cipher,
          signing_secret_cipher: slack_publications.signing_secret_cipher,
          slack_app_id: slack_publications.slack_app_id,
        })
        .from(slack_publications)
        .where(eq(slack_publications.id, publicationId)),
    );
    if (!row) return null;
    return {
      clientId: row.client_id,
      hasClientSecret: !!row.client_secret_cipher,
      hasSigningSecret: !!row.signing_secret_cipher,
      slackAppId: row.slack_app_id,
    };
  }

  async bindInstallation(input: {
    publicationId: string;
    installationId: string;
    slackAppId: string;
  }): Promise<void> {
    await runOnce(
      this.db
        .update(slack_publications)
        .set({
          installation_id: input.installationId,
          slack_app_id: input.slackAppId,
          status: "live",
        })
        .where(eq(slack_publications.id, input.publicationId)),
    );
  }

  async findBySlackAppId(slackAppId: string): Promise<Publication | null> {
    const row = await getOne<typeof slack_publications.$inferSelect>(
      this.db
        .select()
        .from(slack_publications)
        .where(eq(slack_publications.slack_app_id, slackAppId))
        .limit(1),
    );
    return row ? this.toDomain(row) : null;
  }

  async updateStatus(id: string, status: PublicationStatus): Promise<void> {
    await runOnce(
      this.db
        .update(slack_publications)
        .set({ status })
        .where(eq(slack_publications.id, id)),
    );
  }

  async updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void> {
    await runOnce(
      this.db
        .update(slack_publications)
        .set({ capabilities: JSON.stringify([...capabilities]) })
        .where(eq(slack_publications.id, id)),
    );
  }

  async updatePersona(id: string, persona: Persona): Promise<void> {
    await runOnce(
      this.db
        .update(slack_publications)
        .set({
          persona_name: persona.name,
          persona_avatar_url: persona.avatarUrl,
        })
        .where(eq(slack_publications.id, id)),
    );
  }

  async markUnpublished(id: string, at: number): Promise<void> {
    await runOnce(
      this.db
        .update(slack_publications)
        .set({ status: "unpublished", unpublished_at: at })
        .where(eq(slack_publications.id, id)),
    );
  }

  private toDomain(row: typeof slack_publications.$inferSelect): Publication {
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
