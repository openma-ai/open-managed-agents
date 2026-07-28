// Environments table (CF SQLite / D1).
//
// Hot fields (status, sandbox_worker_name) are denormalized columns — they
// are read on every session-attached request via getSandboxBinding(). The
// rest of the env (packages, networking, sandbox build) lives in the
// `config` JSON blob.
//
// Sources:
//   apps/main/migrations/_archive/0001_schema.sql        (base shape)
//   apps/main/migrations/_archive/0006_env_image_strategy.sql
//     (image_strategy + image_handle nullable columns)
//   apps/main/migrations/_archive/0013_cursor_pagination_indexes.sql

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey().notNull(),
    tenant_id: text("tenant_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull(),
    sandbox_worker_name: text("sandbox_worker_name"),
    build_error: text("build_error"),
    config: text("config").notNull(),
    metadata: text("metadata"),
    created_at: integer("created_at").notNull(),
    updated_at: integer("updated_at"),
    archived_at: integer("archived_at"),
    // Added 0006. NULL = pre-migration row, treated as 'dockerfile'.
    image_strategy: text("image_strategy"),
    // JSON blob from EnvironmentImageStrategy.prepare().
    image_handle: text("image_handle"),
  },
  (t) => [
    index("idx_environments_tenant").on(t.tenant_id, t.archived_at),
    index("idx_environments_tenant_created_id").on(t.tenant_id, t.created_at, t.id),
  ],
);
