// SQL publication repo for Feishu (D1 / SQLite).
//
// Mirrors packages/integrations-adapters-cf/src/d1/slack/publication-repo.ts
// but with feishu_* column names and Feishu-specific credential staging.

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { feishu_publications } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  CapabilityKey,
  CapabilitySet,
  Crypto,
  IdGenerator,
  NewPublication,
  Persona,
  Publication,
  PublicationMode,
  PublicationStatus,
  SessionGranularity,
} from "@open-managed-agents/integrations-core";
import type {
  FeishuPublicationRepo,
  FeishuPublicationCredentialState,
} from "@open-managed-agents/feishu";

export class SqlFeishuPublicationRepo implements FeishuPublicationRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly ids: IdGenerator,
    private readonly crypto: Crypto,
  ) {
    this.db = asBuilder(db);
  }

  async get(id: string): Promise<Publication | null> {
    const row = await getOne<typeof feishu_publications.$inferSelect>(
      this.db
        .select()
        .from(feishu_publications)
        .where(eq(feishu_publications.id, id)),
    );
    return row ? this.toDomain(row) : null;
  }

  async listByInstallation(installationId: string): Promise<readonly Publication[]> {
    const rows = await getAll<typeof feishu_publications.$inferSelect>(
      this.db
        .select()
        .from(feishu_publications)
        .where(eq(feishu_publications.installation_id, installationId))
        .orderBy(desc(feishu_publications.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async listByUserAndAgent(
    userId: string,
    agentId: string,
  ): Promise<readonly Publication[]> {
    const rows = await getAll<typeof feishu_publications.$inferSelect>(
      this.db
        .select()
        .from(feishu_publications)
        .where(
          and(
            eq(feishu_publications.user_id, userId),
            eq(feishu_publications.agent_id, agentId),
          ),
        )
        .orderBy(desc(feishu_publications.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async listPendingByUser(userId: string): Promise<readonly Publication[]> {
    const rows = await getAll<typeof feishu_publications.$inferSelect>(
      this.db
        .select()
        .from(feishu_publications)
        .where(
          and(
            eq(feishu_publications.user_id, userId),
            inArray(feishu_publications.status, [
              "pending_setup",
              "credentials_filled",
              "awaiting_install",
            ]),
          ),
        )
        .orderBy(desc(feishu_publications.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async insert(row: NewPublication): Promise<Publication> {
    const id = this.ids.generate();
    const now = Date.now();
    await runOnce(
      this.db.insert(feishu_publications).values({
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
    input: {
      appId: string;
      appSecretCipher: string;
      verificationTokenCipher: string;
      encryptKeyCipher: string;
    },
  ): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_publications)
        .set({
          app_id: input.appId,
          app_secret_cipher: input.appSecretCipher,
          verification_token_cipher: input.verificationTokenCipher,
          encrypt_key_cipher: input.encryptKeyCipher,
          status: "credentials_filled",
        })
        .where(eq(feishu_publications.id, publicationId)),
    );
  }

  async getAppSecret(publicationId: string): Promise<string | null> {
    const row = await getOne<{ app_secret_cipher: string | null }>(
      this.db
        .select({ app_secret_cipher: feishu_publications.app_secret_cipher })
        .from(feishu_publications)
        .where(eq(feishu_publications.id, publicationId)),
    );
    if (!row?.app_secret_cipher) return null;
    return this.crypto.decrypt(row.app_secret_cipher);
  }

  async getEncryptKey(publicationId: string): Promise<string | null> {
    const row = await getOne<{ encrypt_key_cipher: string | null }>(
      this.db
        .select({ encrypt_key_cipher: feishu_publications.encrypt_key_cipher })
        .from(feishu_publications)
        .where(eq(feishu_publications.id, publicationId)),
    );
    if (!row?.encrypt_key_cipher) return null;
    return this.crypto.decrypt(row.encrypt_key_cipher);
  }

  async getVerificationToken(publicationId: string): Promise<string | null> {
    const row = await getOne<{ verification_token_cipher: string | null }>(
      this.db
        .select({ verification_token_cipher: feishu_publications.verification_token_cipher })
        .from(feishu_publications)
        .where(eq(feishu_publications.id, publicationId)),
    );
    if (!row?.verification_token_cipher) return null;
    return this.crypto.decrypt(row.verification_token_cipher);
  }

  async getCredentialState(
    publicationId: string,
  ): Promise<FeishuPublicationCredentialState | null> {
    const row = await getOne<{
      app_id: string | null;
      app_secret_cipher: string | null;
      verification_token_cipher: string | null;
      encrypt_key_cipher: string | null;
    }>(
      this.db
        .select({
          app_id: feishu_publications.app_id,
          app_secret_cipher: feishu_publications.app_secret_cipher,
          verification_token_cipher: feishu_publications.verification_token_cipher,
          encrypt_key_cipher: feishu_publications.encrypt_key_cipher,
        })
        .from(feishu_publications)
        .where(eq(feishu_publications.id, publicationId)),
    );
    if (!row) return null;
    return {
      appId: row.app_id,
      hasAppSecret: !!row.app_secret_cipher,
      hasVerificationToken: !!row.verification_token_cipher,
      hasEncryptKey: !!row.encrypt_key_cipher,
    };
  }

  async bindInstallation(input: {
    publicationId: string;
    installationId: string;
  }): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_publications)
        .set({
          installation_id: input.installationId,
          status: "live",
        })
        .where(eq(feishu_publications.id, input.publicationId)),
    );
  }

  async findByAppId(appId: string): Promise<Publication | null> {
    // One Feishu App accumulates multiple publication rows over its
    // lifetime (retried wizard runs, unpublished leftovers). Rank active
    // rows first — live > awaiting_install > credentials_filled >
    // pending_setup > anything else, newest within a rank — so a stale
    // row can never shadow a live or pending publication sharing the
    // same app_id (the WS runner's flip and the provider's inbound
    // routing both rely on this lookup).
    const rows = await getAll<typeof feishu_publications.$inferSelect>(
      this.db
        .select()
        .from(feishu_publications)
        .where(eq(feishu_publications.app_id, appId)),
    );
    if (rows.length === 0) return null;
    const rank = (s: string): number =>
      s === "live" ? 0
      : s === "awaiting_install" ? 1
      : s === "credentials_filled" ? 2
      : s === "pending_setup" ? 3
      : 4;
    rows.sort(
      (a, b) => rank(a.status) - rank(b.status) || b.created_at - a.created_at,
    );
    return this.toDomain(rows[0]!);
  }

  async updateStatus(id: string, status: PublicationStatus): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_publications)
        .set({ status })
        .where(eq(feishu_publications.id, id)),
    );
  }

  async updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_publications)
        .set({ capabilities: JSON.stringify([...capabilities]) })
        .where(eq(feishu_publications.id, id)),
    );
  }

  async updatePersona(id: string, persona: Persona): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_publications)
        .set({
          persona_name: persona.name,
          persona_avatar_url: persona.avatarUrl,
        })
        .where(eq(feishu_publications.id, id)),
    );
  }

  async markUnpublished(id: string, at: number): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_publications)
        .set({ status: "unpublished", unpublished_at: at })
        .where(eq(feishu_publications.id, id)),
    );
  }

  private toDomain(row: typeof feishu_publications.$inferSelect): Publication {
    const caps = JSON.parse(row.capabilities) as CapabilityKey[];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      agentId: row.agent_id,
      installationId: row.installation_id,
      environmentId: row.environment_id,
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
