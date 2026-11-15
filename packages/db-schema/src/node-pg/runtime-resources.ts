import { bigint, pgTable, text } from "drizzle-orm/pg-core";

/**
 * ManagedRuntimeHost durable retry queue for provider sandboxes that survived
 * a failed release (ADR 0005). Written only through
 * @open-managed-agents/sandbox-orphan-store-sql. Ownership and the restore
 * pointer live on the Work claim (managed_environment_work), not here.
 */
export const runtime_resource_orphans = pgTable("runtime_resource_orphans", {
  id: text("id").primaryKey(),
  workspace_id: text("workspace_id").notNull(),
  environment_id: text("environment_id").notNull(),
  session_id: text("session_id").notNull(),
  work_id: text("work_id").notNull(),
  generation: bigint("generation", { mode: "number" }).notNull(),
  owner_id: text("owner_id").notNull(),
  sandbox_json: text("sandbox_json").notNull(),
  reason: text("reason").notNull(),
  attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
  last_error: text("last_error").notNull(),
});
