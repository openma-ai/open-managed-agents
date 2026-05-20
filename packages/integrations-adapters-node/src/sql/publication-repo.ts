import type { SqlClient } from "@open-managed-agents/sql-client";

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
}

/** Sentinel used for `installation_id` on rows that haven't bound yet. */
const PENDING_INSTALLATION_ID = "";

/**
 * Linear publication repo for the Node runtime. Mirrors the CF
 * D1PublicationRepo's publication-first surface. See
 * `packages/integrations-adapters-cf/src/d1/publication-repo.ts` for the
 * design rationale and `packages/integrations-core/src/persistence.ts`
 * for the LinearPublicationRepo port contract.
 */
export class SqlPublicationRepo implements LinearPublicationRepo {
  constructor(
    private readonly db: SqlClient,
    private readonly ids: IdGenerator,
    /** Optional Crypto port. Required for the publication-first methods
     *  (set/get credentials). Hosts wiring legacy install paths only can
     *  pass undefined. */
    private readonly crypto?: Crypto,
  ) {}

  async get(id: string): Promise<Publication | null> {
    const row = await this.db
      .prepare(`SELECT * FROM linear_publications WHERE id = ?`)
      .bind(id)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async listByInstallation(installationId: string): Promise<readonly Publication[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_publications WHERE installation_id = ?
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
        `SELECT * FROM linear_publications WHERE user_id = ? AND agent_id = ?
         ORDER BY created_at DESC`,
      )
      .bind(userId, agentId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async listPendingByUser(userId: string): Promise<readonly Publication[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM linear_publications
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
        `INSERT INTO linear_publications (
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
        // D1 rejects undefined; coerce to null when persona has no avatar.
        row.persona.avatarUrl ?? null,
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

  async insertShell(row: NewPublicationShell): Promise<Publication> {
    const id = this.ids.generate();
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO linear_publications (
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
        PENDING_INSTALLATION_ID,
        row.environmentId,
        row.mode,
        "pending_setup",
        row.persona.name,
        row.persona.avatarUrl ?? null,
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
        "SqlPublicationRepo.setCredentials: Crypto port required for publication-first flow",
      );
    }
    const clientSecretCipher = await this.crypto.encrypt(input.clientSecret);
    const webhookSecretCipher = await this.crypto.encrypt(input.webhookSecret);
    const signingSecretCipher =
      input.signingSecret == null ? null : await this.crypto.encrypt(input.signingSecret);
    await this.db
      .prepare(
        `UPDATE linear_publications
           SET client_id = ?,
               client_secret_cipher = ?,
               webhook_secret_cipher = ?,
               signing_secret_cipher = ?,
               status = 'awaiting_install'
         WHERE id = ?`,
      )
      .bind(
        input.clientId,
        clientSecretCipher,
        webhookSecretCipher,
        signingSecretCipher,
        id,
      )
      .run();
  }

  async getCredentials(id: string): Promise<PublicationCredentials | null> {
    if (!this.crypto) return null;
    const row = await this.db
      .prepare(
        `SELECT client_id, client_secret_cipher, webhook_secret_cipher,
                signing_secret_cipher
           FROM linear_publications WHERE id = ?`,
      )
      .bind(id)
      .first<{
        client_id: string | null;
        client_secret_cipher: string | null;
        webhook_secret_cipher: string | null;
        signing_secret_cipher: string | null;
      }>();
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
    const row = await this.db
      .prepare(`SELECT webhook_secret_cipher FROM linear_publications WHERE id = ?`)
      .bind(id)
      .first<{ webhook_secret_cipher: string | null }>();
    if (!row || !row.webhook_secret_cipher) return null;
    return this.crypto.decrypt(row.webhook_secret_cipher);
  }

  async getClientSecret(id: string): Promise<string | null> {
    if (!this.crypto) return null;
    const row = await this.db
      .prepare(`SELECT client_secret_cipher FROM linear_publications WHERE id = ?`)
      .bind(id)
      .first<{ client_secret_cipher: string | null }>();
    if (!row || !row.client_secret_cipher) return null;
    return this.crypto.decrypt(row.client_secret_cipher);
  }

  async bindInstallation(
    id: string,
    args: { installationId: string; vaultId: string | null },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_publications
           SET installation_id = ?,
               vault_id = ?,
               status = 'live'
         WHERE id = ?`,
      )
      .bind(args.installationId, args.vaultId, id)
      .run();
  }

  async updateStatus(id: string, status: PublicationStatus): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_publications SET status = ? WHERE id = ?`)
      .bind(status, id)
      .run();
  }

  async updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void> {
    await this.db
      .prepare(`UPDATE linear_publications SET capabilities = ? WHERE id = ?`)
      .bind(JSON.stringify([...capabilities]), id)
      .run();
  }

  async updatePersona(id: string, persona: Persona): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_publications
         SET persona_name = ?, persona_avatar_url = ? WHERE id = ?`,
      )
      .bind(persona.name, persona.avatarUrl, id)
      .run();
  }

  async markUnpublished(id: string, at: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE linear_publications
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
