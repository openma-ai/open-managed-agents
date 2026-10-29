import { migrateLegacyAgents } from "@open-managed-agents/agent-store-sql/legacy-agents-migration";
import type { SqlClient } from "@open-managed-agents/sql-client";

/**
 * Run immediately before the normal Node schema migrator. Moves agents from
 * the legacy tables into `managed_agents`, so the migration that drops the
 * legacy tables finds them empty. A no-op once the tables are gone.
 */
export async function moveLegacyAgents(
  sql: SqlClient,
  dialect: "sqlite" | "postgres" | "mysql",
): Promise<void> {
  const exists = await sql.prepare(
    dialect === "sqlite"
      ? "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agents'"
      : dialect === "postgres"
        ? "SELECT 1 AS present FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'agents'"
        : "SELECT 1 AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'agents'",
  ).first();
  if (!exists) return;
  await migrateLegacyAgents(sql);
}
