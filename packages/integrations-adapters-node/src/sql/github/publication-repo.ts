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
  GitHubPublicationCredentialState,
  GitHubPublicationRepo,
} from "@open-managed-agents/github";

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
  app_oma_id: string | null;
  client_id: string | null;
  client_secret_cipher: string | null;
  app_id: string | null;
  app_slug: string | null;
  bot_login: string | null;
  webhook_secret_cipher: string | null;
  private_key_cipher: string | null;
  vault_id: string | null;
}

/**
 * SQL publication repo for GitHub. Mirrors D1GitHubPublicationRepo
 * verbatim; targets `github_publications`. Implements the
 * publication-first GitHubPublicationRepo extension on top of base
 * PublicationRepo. See packages/github/src/ports.ts for contract.
 */
export class SqlGitHubPublicationRepo implements GitHubPublicationRepo {
  constructor(
    private readonly db: SqlClient,
    private readonly ids: IdGenerator,
    private readonly crypto: Crypto,
  ) {}

  async get(id: string): Promise<Publication | null> {
    const row = await this.db
      .prepare(`SELECT * FROM github_publications WHERE id = ?`)
      .bind(id)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  async listByInstallation(installationId: string): Promise<readonly Publication[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM github_publications WHERE installation_id = ?
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
        `SELECT * FROM github_publications WHERE user_id = ? AND agent_id = ?
         ORDER BY created_at DESC`,
      )
      .bind(userId, agentId)
      .all<Row>();
    return (results ?? []).map((r) => this.toDomain(r));
  }

  async listPendingByUser(userId: string): Promise<readonly Publication[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM github_publications
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
        `INSERT INTO github_publications (
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

  // ─── Publication-first methods (migration 0002) ────────────────────────

  async insertShell(input: {
    tenantId: string;
    userId: string;
    agentId: string;
    environmentId: string;
    persona: Persona;
    capabilities: ReadonlySet<CapabilityKey>;
    sessionGranularity: SessionGranularity;
  }): Promise<{ publication: Publication; appOmaId: string }> {
    const id = this.ids.generate();
    const appOmaId = this.ids.generate();
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO github_publications (
           id, tenant_id, user_id, agent_id, installation_id, environment_id, mode, status,
           persona_name, persona_avatar_url, capabilities,
           session_granularity, created_at, unpublished_at,
           app_oma_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        id,
        input.tenantId,
        input.userId,
        input.agentId,
        "",
        input.environmentId,
        "full",
        "pending_setup",
        input.persona.name,
        input.persona.avatarUrl ?? null,
        JSON.stringify([...input.capabilities]),
        input.sessionGranularity,
        now,
        appOmaId,
      )
      .run();
    const publication: Publication = {
      id,
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
      createdAt: now,
      unpublishedAt: null,
    };
    return { publication, appOmaId };
  }

  async setCredentials(
    publicationId: string,
    input: {
      appId: string;
      appSlug: string;
      botLogin: string;
      clientId: string | null;
      clientSecretCipher: string | null;
      webhookSecretCipher: string;
      privateKeyCipher: string;
    },
  ): Promise<void> {
    const row = await this.db
      .prepare(`SELECT status FROM github_publications WHERE id = ?`)
      .bind(publicationId)
      .first<{ status: string }>();
    if (!row) {
      throw new Error(`setCredentials: publication ${publicationId} not found`);
    }
    if (row.status === "unpublished") {
      throw new Error(
        `setCredentials: publication ${publicationId} is unpublished — restart the publish flow`,
      );
    }
    const promoteStatus = row.status === "pending_setup";
    await this.db
      .prepare(
        `UPDATE github_publications SET
           app_id = ?, app_slug = ?, bot_login = ?,
           client_id = ?, client_secret_cipher = ?,
           webhook_secret_cipher = ?, private_key_cipher = ?
           ${promoteStatus ? ", status = 'credentials_filled'" : ""}
         WHERE id = ?`,
      )
      .bind(
        input.appId,
        input.appSlug,
        input.botLogin,
        input.clientId,
        input.clientSecretCipher,
        input.webhookSecretCipher,
        input.privateKeyCipher,
        publicationId,
      )
      .run();
  }

  async getClientSecret(publicationId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT client_secret_cipher FROM github_publications WHERE id = ?`,
      )
      .bind(publicationId)
      .first<{ client_secret_cipher: string | null }>();
    if (!row || row.client_secret_cipher == null) return null;
    return this.crypto.decrypt(row.client_secret_cipher);
  }

  async getWebhookSecret(publicationId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT webhook_secret_cipher FROM github_publications WHERE id = ?`,
      )
      .bind(publicationId)
      .first<{ webhook_secret_cipher: string | null }>();
    if (!row || row.webhook_secret_cipher == null) return null;
    return this.crypto.decrypt(row.webhook_secret_cipher);
  }

  async getPrivateKey(publicationId: string): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT private_key_cipher FROM github_publications WHERE id = ?`,
      )
      .bind(publicationId)
      .first<{ private_key_cipher: string | null }>();
    if (!row || row.private_key_cipher == null) return null;
    return this.crypto.decrypt(row.private_key_cipher);
  }

  async getCredentialState(
    publicationId: string,
  ): Promise<GitHubPublicationCredentialState | null> {
    const row = await this.db
      .prepare(
        `SELECT app_oma_id, client_id, client_secret_cipher, app_id, app_slug,
                bot_login, webhook_secret_cipher, private_key_cipher, vault_id
         FROM github_publications WHERE id = ?`,
      )
      .bind(publicationId)
      .first<{
        app_oma_id: string | null;
        client_id: string | null;
        client_secret_cipher: string | null;
        app_id: string | null;
        app_slug: string | null;
        bot_login: string | null;
        webhook_secret_cipher: string | null;
        private_key_cipher: string | null;
        vault_id: string | null;
      }>();
    if (!row) return null;
    return {
      appOmaId: row.app_oma_id,
      appId: row.app_id,
      appSlug: row.app_slug,
      botLogin: row.bot_login,
      clientId: row.client_id,
      hasClientSecret: row.client_secret_cipher != null,
      hasWebhookSecret: row.webhook_secret_cipher != null,
      hasPrivateKey: row.private_key_cipher != null,
      vaultId: row.vault_id,
    };
  }

  async bindInstallation(input: {
    publicationId: string;
    installationId: string;
    vaultId: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_publications
           SET installation_id = ?, vault_id = ?, status = 'live'
         WHERE id = ?`,
      )
      .bind(input.installationId, input.vaultId, input.publicationId)
      .run();
  }

  async findByAppOmaId(appOmaId: string): Promise<Publication | null> {
    const row = await this.db
      .prepare(`SELECT * FROM github_publications WHERE app_oma_id = ? LIMIT 1`)
      .bind(appOmaId)
      .first<Row>();
    return row ? this.toDomain(row) : null;
  }

  // ─── Base PublicationRepo: status / persona / capabilities updates ─────

  async updateStatus(id: string, status: PublicationStatus): Promise<void> {
    await this.db
      .prepare(`UPDATE github_publications SET status = ? WHERE id = ?`)
      .bind(status, id)
      .run();
  }

  async updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void> {
    await this.db
      .prepare(`UPDATE github_publications SET capabilities = ? WHERE id = ?`)
      .bind(JSON.stringify([...capabilities]), id)
      .run();
  }

  async updatePersona(id: string, persona: Persona): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_publications
         SET persona_name = ?, persona_avatar_url = ? WHERE id = ?`,
      )
      .bind(persona.name, persona.avatarUrl, id)
      .run();
  }

  async markUnpublished(id: string, at: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE github_publications
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
