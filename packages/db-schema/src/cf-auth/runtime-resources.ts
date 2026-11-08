import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * ManagedRuntimeHost tables (ADR 0005): the Environment Work publication fence
 * and the durable retry queue for provider sandboxes that survived a failed
 * release. Written only through @open-managed-agents/runtime-resource-fence-sql.
 */
export const runtime_resource_fences = sqliteTable(
  "runtime_resource_fences",
  {
    scope_key: text("scope_key").primaryKey(),
    workspace_id: text("workspace_id").notNull(),
    environment_id: text("environment_id").notNull(),
    session_id: text("session_id").notNull(),
    work_id: text("work_id").notNull(),
    generation: integer("generation").notNull(),
    owner_id: text("owner_id").notNull(),
    fence_token: text("fence_token").notNull(),
    expires_at_ms: integer("expires_at_ms").notNull(),
    publication_json: text("publication_json"),
    publication_generation: integer("publication_generation"),
    revision: integer("revision").notNull().default(0),
  },
  (table) => [index("runtime_resource_fences_expiry_idx").on(table.expires_at_ms)],
);

export const runtime_resource_orphans = sqliteTable("runtime_resource_orphans", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  environment_id: text("environment_id").notNull(),
  session_id: text("session_id").notNull(),
  work_id: text("work_id").notNull(),
  generation: integer("generation").notNull(),
  owner_id: text("owner_id").notNull(),
  sandbox_json: text("sandbox_json").notNull(),
  reason: text("reason").notNull(),
  attempts: integer("attempts").notNull().default(0),
  last_error: text("last_error").notNull(),
});
