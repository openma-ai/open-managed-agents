import type { SqlClient } from "@open-managed-agents/sql-client";

/**
 * The first Node baseline called the workspace blob column `blob_key` and
 * keyed rows by `session_id`. The workspace backup service now stores a
 * serialized handle in `backup_handle` and scopes rows with
 * `source_session_id` and `environment_id`. Repair an existing baseline
 * before the service reads the newer shape.
 */
export async function reconcileWorkspaceBackupsMigration(
  sql: SqlClient,
  dialect: "sqlite" | "postgres" | "mysql",
): Promise<void> {
  const columns = new Set<string>();
  if (dialect === "sqlite") {
    const result = await sql.prepare("PRAGMA table_info(workspace_backups)").all<{ name: string }>();
    for (const row of result.results ?? []) columns.add(row.name);
  } else {
    const result = await sql.prepare(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_name = 'workspace_backups'
       ${dialect === "mysql" ? "AND table_schema = DATABASE()" : "AND table_schema = current_schema()"}`,
    ).all<{ name: string }>();
    for (const row of result.results ?? []) columns.add(row.name);
  }
  if (columns.size === 0) return;

  const addColumn = async (name: string) => {
    if (columns.has(name)) return;
    await sql.exec(`ALTER TABLE workspace_backups ADD COLUMN ${name} TEXT`);
    columns.add(name);
  };
  await addColumn("environment_id");
  await addColumn("backup_handle");
  await addColumn("source_session_id");

  // Preserve old rows when the old names are present. New rows use the
  // canonical columns above. A raw blob key remains a valid restore handle.
  if (columns.has("blob_key")) {
    await sql.exec("UPDATE workspace_backups SET backup_handle = blob_key WHERE backup_handle IS NULL");
  }
  if (columns.has("session_id")) {
    await sql.exec("UPDATE workspace_backups SET source_session_id = session_id WHERE source_session_id IS NULL");
    await sql.exec("UPDATE workspace_backups SET environment_id = session_id WHERE environment_id IS NULL");
  }
}
