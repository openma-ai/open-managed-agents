// SQL setup-link repo for Feishu (D1 / SQLite).
//
// Mirrors packages/integrations-adapters-cf/src/d1/slack/setup-link-repo.ts
// but writes to feishu_setup_links. Same shape, different table.

import { eq, lt } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@open-managed-agents/db-schema";
import { feishu_setup_links } from "@open-managed-agents/db-schema/cf-integrations";
import type {
  IdGenerator,
  NewSetupLink,
  SetupLink,
  SetupLinkRepo,
} from "@open-managed-agents/integrations-core";

export class SqlFeishuSetupLinkRepo implements SetupLinkRepo {
  private readonly db: OmaDbBuilder;
  constructor(
    db: OmaDb,
    private readonly ids: IdGenerator,
  ) {
    this.db = asBuilder(db);
  }

  async get(token: string): Promise<SetupLink | null> {
    const row = await getOne<typeof feishu_setup_links.$inferSelect>(
      this.db
        .select()
        .from(feishu_setup_links)
        .where(eq(feishu_setup_links.token, token)),
    );
    return row ? this.toDomain(row) : null;
  }

  async insert(row: NewSetupLink): Promise<SetupLink> {
    const token = this.ids.generate();
    await runOnce(
      this.db.insert(feishu_setup_links).values({
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

  async markUsed(
    token: string,
    usedByEmail: string,
    usedAt: number,
  ): Promise<void> {
    await runOnce(
      this.db
        .update(feishu_setup_links)
        .set({ used_at: usedAt, used_by_email: usedByEmail })
        .where(eq(feishu_setup_links.token, token)),
    );
  }

  async deleteExpired(now: number): Promise<number> {
    const deleted = await getAll<{ token: string }>(
      this.db
        .delete(feishu_setup_links)
        .where(lt(feishu_setup_links.expires_at, now))
        .returning({ token: feishu_setup_links.token }),
    );
    return deleted.length;
  }

  private toDomain(
    row: typeof feishu_setup_links.$inferSelect,
  ): SetupLink {
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
