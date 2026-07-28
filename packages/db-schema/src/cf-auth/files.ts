// Files + workspace_backups (CF SQLite / D1).
//
// Tables:
//   files              — per-file metadata; R2 owns the blob (see r2_key).
//   workspace_backups  — per-(tenant, environment) DirectoryBackup handle
//                        registry. backup_handle is a small JSON blob
//                        stored as TEXT.
//
// Sources:
//   apps/main/migrations/_archive/0001_schema.sql           (files)
//   apps/main/migrations/_archive/0011_workspace_backups.sql

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    session_id: text("session_id"),
    scope: text("scope").notNull(),
    filename: text("filename").notNull(),
    media_type: text("media_type").notNull(),
    size_bytes: integer("size_bytes").notNull(),
    // Raw integer 0/1 — NOT mode:"boolean" (matches baseline).
    downloadable: integer("downloadable").notNull().default(0),
    r2_key: text("r2_key").notNull(),
    created_at: integer("created_at").notNull(),
  },
  (t) => [
    index("idx_files_tenant_created").on(t.tenant_id, t.created_at),
    index("idx_files_tenant_session_created").on(t.tenant_id, t.session_id, t.created_at),
    index("idx_files_session").on(t.session_id),
  ],
);

export const workspace_backups = sqliteTable(
  "workspace_backups",
  {
    // INTEGER PRIMARY KEY AUTOINCREMENT.
    id: integer("id").primaryKey({ autoIncrement: true }),
    tenant_id: text("tenant_id").notNull(),
    environment_id: text("environment_id").notNull(),
    // JSON: { id, dir, localBucket? } from CF Sandbox SDK createBackup().
    backup_handle: text("backup_handle").notNull(),
    created_at: integer("created_at").notNull(),
    expires_at: integer("expires_at").notNull(),
    source_session_id: text("source_session_id"),
  },
  (t) => [
    index("idx_workspace_backups_scope_recent").on(
      t.tenant_id,
      t.environment_id,
      t.created_at,
    ),
    index("idx_workspace_backups_expires").on(t.expires_at),
  ],
);
