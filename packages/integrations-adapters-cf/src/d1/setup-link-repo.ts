import { eq, lt } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { linear_setup_links } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  IdGenerator,
  NewSetupLink,
  SetupLink,
  SetupLinkRepo,
} from "@open-managed-agents/integrations-core";

/**
 * SQL setup-link repo for Linear. Targets `linear_setup_links`. Holds
 * non-admin handoff tokens (publisher → workspace admin).
 */
export class SqlLinearSetupLinkRepo implements SetupLinkRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly ids: IdGenerator,
  ) {
    this.db = asBuilder(db);
  }

  async get(token: string): Promise<SetupLink | null> {
    const row = await getOne<typeof linear_setup_links.$inferSelect>(
      this.db
        .select()
        .from(linear_setup_links)
        .where(eq(linear_setup_links.token, token)),
    );
    return row ? this.toDomain(row) : null;
  }

  async insert(row: NewSetupLink): Promise<SetupLink> {
    // 32 bytes of entropy, hex-encoded → 64 char URL-safe token.
    const token = this.ids.generate();
    await runOnce(
      this.db.insert(linear_setup_links).values({
        token,
        tenant_id: row.tenantId,
        publication_id: row.publicationId,
        created_by: row.createdBy,
        expires_at: row.expiresAt,
        used_at: null,
        used_by_email: null,
      }),
    );
    return {
      token,
      tenantId: row.tenantId,
      publicationId: row.publicationId,
      createdBy: row.createdBy,
      expiresAt: row.expiresAt,
      usedAt: null,
      usedByEmail: null,
    };
  }

  async markUsed(token: string, usedByEmail: string, usedAt: number): Promise<void> {
    await runOnce(
      this.db
        .update(linear_setup_links)
        .set({ used_at: usedAt, used_by_email: usedByEmail })
        .where(eq(linear_setup_links.token, token)),
    );
  }

  async deleteExpired(now: number): Promise<number> {
    // RETURNING tells us how many rows were actually deleted, dialect-agnostic.
    const deleted = await getAll<{ token: string }>(
      this.db
        .delete(linear_setup_links)
        .where(lt(linear_setup_links.expires_at, now))
        .returning({ token: linear_setup_links.token }),
    );
    return deleted.length;
  }

  private toDomain(row: typeof linear_setup_links.$inferSelect): SetupLink {
    return {
      token: row.token,
      tenantId: row.tenant_id,
      publicationId: row.publication_id,
      createdBy: row.created_by,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      usedByEmail: row.used_by_email,
    };
  }
}
