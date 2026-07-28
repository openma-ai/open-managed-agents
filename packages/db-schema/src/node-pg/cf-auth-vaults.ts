// Vaults + credentials (Node-PG variant of cf-auth/vaults).

import { sql } from "drizzle-orm";
import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

export const vaults = pgTable(
  "vaults",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    name: text("name").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }),
    archived_at: bigint("archived_at", { mode: "number" }),
  },
  (t) => [index("idx_vaults_tenant").on(t.tenant_id, t.archived_at)],
);

export const credentials = pgTable(
  "credentials",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    vault_id: text("vault_id").notNull(),
    display_name: text("display_name").notNull(),
    auth_type: text("auth_type").notNull(),
    mcp_server_url: text("mcp_server_url"),
    provider: text("provider"),
    auth: text("auth").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }),
    archived_at: bigint("archived_at", { mode: "number" }),
  },
  (t) => [
    index("idx_credentials_vault").on(t.tenant_id, t.vault_id, t.archived_at),
    uniqueIndex("idx_credentials_mcp_url_active")
      .on(t.tenant_id, t.vault_id, t.mcp_server_url)
      .where(sql`"mcp_server_url" IS NOT NULL AND "archived_at" IS NULL`),
    index("idx_credentials_provider")
      .on(t.tenant_id, t.vault_id, t.provider)
      .where(sql`"provider" IS NOT NULL`),
  ],
);
