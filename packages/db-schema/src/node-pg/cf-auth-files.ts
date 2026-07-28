// Files + workspace_backups (Node-PG variant of cf-auth/files).
//
// Diverges from CF in two places:
//   - workspace_backups.id is TEXT on PG (matches applySchema source),
//     not the AUTOINCREMENT INTEGER from CF migration 0011.
//   - PG variant adds session_id + blob_key columns that CF lacks
//     (CF stores backup_handle as a JSON blob with id/dir inside it).
// Both deltas are tracked drift; Phase 3 will reconcile.

import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    session_id: text("session_id"),
    scope: text("scope").notNull(),
    filename: text("filename").notNull(),
    media_type: text("media_type").notNull(),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // Integer flag (NOT boolean) to mirror CF / source SQL.
    downloadable: bigint("downloadable", { mode: "number" }).notNull().default(0),
    r2_key: text("r2_key").notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_files_tenant_created").on(t.tenant_id, t.created_at),
    index("idx_files_tenant_session_created").on(t.tenant_id, t.session_id, t.created_at),
    index("idx_files_session").on(t.session_id),
  ],
);

export const workspace_backups = pgTable(
  "workspace_backups",
  {
    // PG path uses TEXT id (matches packages/schema/src/index.ts).
    // CF path uses INTEGER AUTOINCREMENT (matches the 0011 migration).
    // Drift tracked; reconciliation will land in Phase 3.
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    session_id: text("session_id").notNull(),
    blob_key: text("blob_key").notNull(),
    size_bytes: bigint("size_bytes", { mode: "number" }).notNull(),
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    expires_at: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("idx_workspace_backups_session").on(t.session_id, t.created_at),
    index("idx_workspace_backups_expires").on(t.expires_at),
  ],
);
