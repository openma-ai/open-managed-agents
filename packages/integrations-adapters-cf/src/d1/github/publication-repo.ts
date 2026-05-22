import { and, desc, eq, inArray } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { github_publications } from "@open-managed-agents/db-schema/cf-integrations";
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

/**
 * SQL publication repo for GitHub. Implements both the base PublicationRepo
 * (legacy paths) AND the publication-first GitHubPublicationRepo extension
 * (`insertShell`, `setCredentials`, `bindInstallation`, etc.) the new
 * provider flow uses. See packages/github/src/ports.ts for the contract.
 *
 * Targets `github_publications`. See SqlGitHubInstallationRepo for the
 * rationale behind the per-provider table split.
 */
export class SqlGitHubPublicationRepo implements GitHubPublicationRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly ids: IdGenerator,
    private readonly crypto: Crypto,
  ) {
    this.db = asBuilder(db);
  }

  async get(id: string): Promise<Publication | null> {
    const row = await getOne<typeof github_publications.$inferSelect>(
      this.db
        .select()
        .from(github_publications)
        .where(eq(github_publications.id, id)),
    );
    return row ? this.toDomain(row) : null;
  }

  async listByInstallation(installationId: string): Promise<readonly Publication[]> {
    const rows = await getAll<typeof github_publications.$inferSelect>(
      this.db
        .select()
        .from(github_publications)
        .where(eq(github_publications.installation_id, installationId))
        .orderBy(desc(github_publications.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async listByUserAndAgent(
    userId: string,
    agentId: string,
  ): Promise<readonly Publication[]> {
    const rows = await getAll<typeof github_publications.$inferSelect>(
      this.db
        .select()
        .from(github_publications)
        .where(
          and(
            eq(github_publications.user_id, userId),
            eq(github_publications.agent_id, agentId),
          ),
        )
        .orderBy(desc(github_publications.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async listPendingByUser(userId: string): Promise<readonly Publication[]> {
    const rows = await getAll<typeof github_publications.$inferSelect>(
      this.db
        .select()
        .from(github_publications)
        .where(
          and(
            eq(github_publications.user_id, userId),
            inArray(github_publications.status, [
              "pending_setup",
              "credentials_filled",
              "awaiting_install",
            ]),
          ),
        )
        .orderBy(desc(github_publications.created_at)),
    );
    return rows.map((r) => this.toDomain(r));
  }

  async insert(row: NewPublication): Promise<Publication> {
    const id = this.ids.generate();
    const now = Date.now();
    await runOnce(
      this.db.insert(github_publications).values({
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
    // Default trigger_label = lowercased + sanitized persona name (GitHub
    // labels allow alnum + space + dash + underscore + dot + colon). Wizard
    // can edit later via setTriggerLabel.
    const triggerLabel = slugifyForLabel(input.persona.name);
    // installation_id="" is the sentinel for "shell, not yet bound" — the
    // column is NOT NULL in storage so we can't use NULL. bindInstallation
    // overwrites with a real id once the install callback completes.
    await runOnce(
      this.db.insert(github_publications).values({
        id,
        tenant_id: input.tenantId,
        user_id: input.userId,
        agent_id: input.agentId,
        installation_id: "",
        environment_id: input.environmentId,
        mode: "full",
        status: "pending_setup",
        persona_name: input.persona.name,
        persona_avatar_url: input.persona.avatarUrl ?? null,
        capabilities: JSON.stringify([...input.capabilities]),
        session_granularity: input.sessionGranularity,
        created_at: now,
        unpublished_at: null,
        app_oma_id: appOmaId,
        trigger_label: triggerLabel,
      }),
    );
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
    const row = await getOne<{ status: string }>(
      this.db
        .select({ status: github_publications.status })
        .from(github_publications)
        .where(eq(github_publications.id, publicationId)),
    );
    if (!row) {
      throw new Error(`setCredentials: publication ${publicationId} not found`);
    }
    if (row.status === "unpublished") {
      throw new Error(
        `setCredentials: publication ${publicationId} is unpublished — restart the publish flow`,
      );
    }
    // Only promote the status when it's still pre-OAuth. Re-pasting after
    // the user already kicked off an install (status='live' / 'needs_reauth')
    // overwrites cipher columns but leaves status alone — status flips
    // happen on bindInstallation.
    const promoteStatus = row.status === "pending_setup";
    const updates: Record<string, unknown> = {
      app_id: input.appId,
      app_slug: input.appSlug,
      bot_login: input.botLogin,
      client_id: input.clientId,
      client_secret_cipher: input.clientSecretCipher,
      webhook_secret_cipher: input.webhookSecretCipher,
      private_key_cipher: input.privateKeyCipher,
    };
    if (promoteStatus) {
      updates.status = "credentials_filled";
    }
    await runOnce(
      this.db
        .update(github_publications)
        .set(updates)
        .where(eq(github_publications.id, publicationId)),
    );
  }

  async getClientSecret(publicationId: string): Promise<string | null> {
    const row = await getOne<{ client_secret_cipher: string | null }>(
      this.db
        .select({ client_secret_cipher: github_publications.client_secret_cipher })
        .from(github_publications)
        .where(eq(github_publications.id, publicationId)),
    );
    if (!row || row.client_secret_cipher == null) return null;
    return this.crypto.decrypt(row.client_secret_cipher);
  }

  async getWebhookSecret(publicationId: string): Promise<string | null> {
    const row = await getOne<{ webhook_secret_cipher: string | null }>(
      this.db
        .select({ webhook_secret_cipher: github_publications.webhook_secret_cipher })
        .from(github_publications)
        .where(eq(github_publications.id, publicationId)),
    );
    if (!row || row.webhook_secret_cipher == null) return null;
    return this.crypto.decrypt(row.webhook_secret_cipher);
  }

  async getPrivateKey(publicationId: string): Promise<string | null> {
    const row = await getOne<{ private_key_cipher: string | null }>(
      this.db
        .select({ private_key_cipher: github_publications.private_key_cipher })
        .from(github_publications)
        .where(eq(github_publications.id, publicationId)),
    );
    if (!row || row.private_key_cipher == null) return null;
    return this.crypto.decrypt(row.private_key_cipher);
  }

  async getCredentialState(
    publicationId: string,
  ): Promise<GitHubPublicationCredentialState | null> {
    const row = await getOne<{
      app_oma_id: string | null;
      client_id: string | null;
      client_secret_cipher: string | null;
      app_id: string | null;
      app_slug: string | null;
      bot_login: string | null;
      webhook_secret_cipher: string | null;
      private_key_cipher: string | null;
      vault_id: string | null;
    }>(
      this.db
        .select({
          app_oma_id: github_publications.app_oma_id,
          client_id: github_publications.client_id,
          client_secret_cipher: github_publications.client_secret_cipher,
          app_id: github_publications.app_id,
          app_slug: github_publications.app_slug,
          bot_login: github_publications.bot_login,
          webhook_secret_cipher: github_publications.webhook_secret_cipher,
          private_key_cipher: github_publications.private_key_cipher,
          vault_id: github_publications.vault_id,
        })
        .from(github_publications)
        .where(eq(github_publications.id, publicationId)),
    );
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
    await runOnce(
      this.db
        .update(github_publications)
        .set({
          installation_id: input.installationId,
          vault_id: input.vaultId,
          status: "live",
        })
        .where(eq(github_publications.id, input.publicationId)),
    );
  }

  async findByAppOmaId(appOmaId: string): Promise<Publication | null> {
    const row = await getOne<typeof github_publications.$inferSelect>(
      this.db
        .select()
        .from(github_publications)
        .where(eq(github_publications.app_oma_id, appOmaId))
        .limit(1),
    );
    return row ? this.toDomain(row) : null;
  }

  async getTriggerLabel(publicationId: string): Promise<string | null> {
    const row = await getOne<{ trigger_label: string | null }>(
      this.db
        .select({ trigger_label: github_publications.trigger_label })
        .from(github_publications)
        .where(eq(github_publications.id, publicationId)),
    );
    return row?.trigger_label ?? null;
  }

  async setTriggerLabel(publicationId: string, label: string): Promise<void> {
    await runOnce(
      this.db
        .update(github_publications)
        .set({ trigger_label: label })
        .where(eq(github_publications.id, publicationId)),
    );
  }

  // ─── Base PublicationRepo: status / persona / capabilities updates ─────

  async updateStatus(id: string, status: PublicationStatus): Promise<void> {
    await runOnce(
      this.db
        .update(github_publications)
        .set({ status })
        .where(eq(github_publications.id, id)),
    );
  }

  async updateCapabilities(id: string, capabilities: CapabilitySet): Promise<void> {
    await runOnce(
      this.db
        .update(github_publications)
        .set({ capabilities: JSON.stringify([...capabilities]) })
        .where(eq(github_publications.id, id)),
    );
  }

  async updatePersona(id: string, persona: Persona): Promise<void> {
    await runOnce(
      this.db
        .update(github_publications)
        .set({
          persona_name: persona.name,
          persona_avatar_url: persona.avatarUrl,
        })
        .where(eq(github_publications.id, id)),
    );
  }

  async markUnpublished(id: string, at: number): Promise<void> {
    await runOnce(
      this.db
        .update(github_publications)
        .set({ status: "unpublished", unpublished_at: at })
        .where(eq(github_publications.id, id)),
    );
  }

  private toDomain(row: typeof github_publications.$inferSelect): Publication {
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

/**
 * Build a default trigger_label from a persona name. GitHub label names
 * accept most printable chars, but we keep it conservative: lowercase,
 * alnum + hyphen + underscore + dot only; collapse runs of whitespace into
 * single hyphens; trim. If the result is empty, fall back to "oma" so the
 * insert never violates the column's expected non-empty content.
 */
function slugifyForLabel(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._\-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return s.length > 0 ? s : "oma";
}
