import type { SqlClient } from "@open-managed-agents/sql-client";

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
  SlackPublicationRepo,
  SlackPublicationCredentialState,
} from "@open-managed-agents/slack";

interface Row {
  id: string;
  tenant_id: string;
  user_id: string;
  agent_id: string;
  installation_id: string;
  environment_id: string | null;
  mode: string;
  status: string;
  persona_name: string;
  persona_avatar_url: string | null;
  capabilities: string;
  session_granularity: string;
  created_at: number;
  unpublished_at: number | null;
  client_id: string | null;
  client_secret_cipher: string | null;
  signing_secret_cipher: string | null;
  slack_app_id: string | null;
}

export class SqlSlackPublicationRepo implements SlackPublicationRepo {
  constructor(
    private readonly db: SqlClient,
    private readonly ids: IdGenerator,
    private readonly crypto: Crypto,
  ) {}

  async get(id: string): Promise<Publication | null> {
    const row = await this.db
      .prepare(`SELECT * FROM slack_publications WHERE id = ?`)
      .bind(id)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async listByInstallation(installationId: string): Promise<readonly Publication[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM slack_publications WHERE installation_id = ?
         ORDER BY created_at DESC`,
      )
      .bind(installationId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async listByUserAndAgent(
    userId: string,
    agentId: string,
  ): Promise<readonly Publication[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM slack_publications WHERE user_id = ? AND agent_id = ?
         ORDER BY created_at DESC`,
      )
      .bind(userId, agentId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async listPendingByUser(userId: string): Promise<readonly Publication[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM slack_publications
         WHERE user_id = ?
           AND status IN ('pending_setup', 'credentials_filled', 'awaiting_install')
         ORDER BY created_at DESC`,
      )
      .bind(userId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async insert(row: NewPublication): Promise<Publication> {
    const id = this.ids.generate();
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO slack_publications (
           id, tenant_id, user_id, agent_id, installation_id, environment_id, mode, status,
           persona_name, persona_avatar_url, capabilities,
           session_granularity, created_at, unpublished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        id,
        row.tenantId,
        row.userId,
        row.agentId,
        row.installationId,
        row.environmentId,
        row.mode,
        row.status,
        row.persona.name,
        row.persona.avatarUrl,
        JSON.stringify([...row.capabilities]),
        row.sessionGranularity,
        now,
      )
      .run();
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
    input: { clientId: string; clientSecretCipher: string; signingSecretCipher: string },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE slack_publications
         SET client_id = ?, client_secret_cipher = ?, signing_secret_cipher = ?
         WHERE id = ?`,
      )
      .bind(input.clientId, input.clientSecretCipher, input.signingSecretCipher, publicationId)
      .run();
  }

  async getClientSecret(publicationId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT client_secret_cipher FROM slack_publications WHERE id = ?`)
      .bind(publicationId)
      .first<{ client_secret_cipher: string | null }>();
    if (!row?.client_secret_cipher) return null;
    return this.crypto.decrypt(row.client_secret_cipher);
  }

  async getSigningSecret(publicationId: string): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT signing_secret_cipher FROM slack_publications WHERE id = ?`)
      .bind(publicationId)
      .first<{ signing_secret_cipher: string | null }>();
    if (!row?.signing_secret_cipher) return null;
    return this.crypto.decrypt(row.signing_secret_cipher);
  }

  async getCredentialState(
    publicationId: string,
  ): Promise<SlackPublicationCredentialState | null> {
    const row = await this.db
      .prepare(
        `SELECT client_id, client_secret_cipher, signing_secret_cipher, slack_app_id
         FROM slack_publications WHERE id = ?`,
      )
      .bind(publicationId)
      .first<{
        client_id: string | null;
        client_secret_cipher: string | null;
        signing_secret_cipher: string | null;
        slack_app_id: string | null;
      }>();
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
    await this.db
      .prepare(
        `UPDATE slack_publications
         SET installation_id = ?, slack_app_id = ?, status = 'live'
         WHERE id = ?`,
      )
      .bind(input.installationId, input.slackAppId, input.publicationId)
      .run();
  }

  async findBySlackAppId(slackAppId: string): Promise<Publication | null> {
    const row = await this.db
      .prepare(`SELECT * FROM slack_publications WHERE slack_app_id = ? LIMIT 1`)
      .bind(slackAppId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async updateStatus(id: string, status: PublicationStatus): Promise<void> {
    await this.db
      .prepare(`UPDATE slack_publications SET status = ? WHERE id = ?`)
      .bind(status, id)
      .run();
  }

  async updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void> {
    await this.db
      .prepare(`UPDATE slack_publications SET capabilities = ? WHERE id = ?`)
      .bind(JSON.stringify([...capabilities]), id)
      .run();
  }

  async updatePersona(id: string, persona: Persona): Promise<void> {
    await this.db
      .prepare(
        `UPDATE slack_publications
         SET persona_name = ?, persona_avatar_url = ? WHERE id = ?`,
      )
      .bind(persona.name, persona.avatarUrl, id)
      .run();
  }

  async markUnpublished(id: string, at: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE slack_publications
         SET status = 'unpublished', unpublished_at = ? WHERE id = ?`,
      )
      .bind(at, id)
      .run();
  }

  private toDomain(row: Row): Publication {
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
