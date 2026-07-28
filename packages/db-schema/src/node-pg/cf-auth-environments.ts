// Environments (Node-PG variant of cf-auth/environments).
//
// Note: applySchema() does not currently include image_strategy /
// image_handle on the PG path. They are written here so the eventual
// reconciliation lands cleanly. Phase 3 owns the data migration.

import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";

export const environments = pgTable(
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
    created_at: bigint("created_at", { mode: "number" }).notNull(),
    updated_at: bigint("updated_at", { mode: "number" }),
    archived_at: bigint("archived_at", { mode: "number" }),
    image_strategy: text("image_strategy"),
    image_handle: text("image_handle"),
  },
  (t) => [index("idx_environments_tenant").on(t.tenant_id, t.archived_at)],
);
