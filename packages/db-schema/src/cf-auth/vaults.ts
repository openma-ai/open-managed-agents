// Vaults + credentials tables (CF SQLite / D1).
//
// Tables:
//   vaults       — tenant-scoped credential collections.
//   credentials  — three auth types: mcp_oauth | static_bearer |
//                  command_secret. Hot fields (auth_type, mcp_server_url,
//                  provider) are denormalized columns; full
//                  CredentialAuth lives encrypted in `auth` (AES-GCM).
//                  See _archive/0001_schema.sql for the encryption story.
//
// Source: apps/main/migrations/_archive/0001_schema.sql (vaults section)
// + the cursor-pagination index added in
// apps/main/migrations/_archive/0013_cursor_pagination_indexes.sql.

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const vaults = sqliteTable(
  "vaults",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    name: text("name").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at"),
    archived_at: integer("archived_at"),
  },
  (t) => [
    index("idx_vaults_tenant").on(t.tenant_id, t.archived_at),
    index("idx_vaults_tenant_created_id").on(t.tenant_id, t.created_at, t.id),
  ],
);

export const credentials = sqliteTable(
  "credentials",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    vault_id: text("vault_id").notNull(),
    display_name: text("display_name").notNull(),
    auth_type: text("auth_type").notNull(),
    mcp_server_url: text("mcp_server_url"),
    provider: text("provider"),
    // Encrypted JSON blob. Plain TEXT (the adapter does base64url-decode
    // + AES-GCM unwrap) — NEVER mode:"json".
    auth: text("auth").notNull(),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at"),
    archived_at: integer("archived_at"),
  },
  (t) => [
    index("idx_credentials_vault").on(t.tenant_id, t.vault_id, t.archived_at),
    // Partial UNIQUE: at most one ACTIVE credential per
    // (tenant, vault, mcp_server_url). NULLs allowed in mcp_server_url.
    uniqueIndex("idx_credentials_mcp_url_active")
      .on(t.tenant_id, t.vault_id, t.mcp_server_url)
      .where(sql`"mcp_server_url" IS NOT NULL AND "archived_at" IS NULL`),
    // Partial: scan only the provider-tagged credentials at session start.
    index("idx_credentials_provider")
      .on(t.tenant_id, t.vault_id, t.provider)
      .where(sql`"provider" IS NOT NULL`),
  ],
);
