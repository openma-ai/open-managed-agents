import type { SqlClient } from "@open-managed-agents/sql-client";

interface LegacyPublication {
  scope_key: string; workspace_id: string; environment_id: string; session_id: string; work_id: string;
  publication_json: string; publication_generation: number; revision: number;
}
/** Maintenance-only upgrade. Stop legacy publishers before calling. Never
 * retire any source until every routed Work row has been read back exactly.
 * Retries are safe; a conflicting target or a missing shard/Work is an error. */
export async function backfillWorkPublications(source: SqlClient, target: (workspaceId: string) => SqlClient | Promise<SqlClient>) {
  const rows = (await source.prepare("SELECT scope_key, workspace_id, environment_id, session_id, work_id, publication_json, publication_generation, revision FROM runtime_resource_fences WHERE publication_json IS NOT NULL").all<LegacyPublication>()).results ?? [];
  let copied = 0;
  for (const row of rows) {
    const db = await target(row.workspace_id);
    const publication = JSON.stringify({ ...JSON.parse(row.publication_json), generation: Number(row.publication_generation), revision: Number(row.revision) });
    const where = "workspace_id = ? AND environment_id = ? AND session_id = ? AND id = ?";
    const identity = [row.workspace_id, row.environment_id, row.session_id, row.work_id];
    const result = await db.prepare("UPDATE managed_environment_work SET runtime_publication_json = ? WHERE " + where + " AND runtime_publication_json IS NULL").bind(publication, ...identity).run();
    copied += result.meta.changes;
    const found = await db.prepare("SELECT runtime_publication_json FROM managed_environment_work WHERE " + where).bind(...identity).first<{ runtime_publication_json: string | null }>();
    if (found?.runtime_publication_json !== publication) throw new Error("Work publication coverage incomplete at " + row.scope_key);
  }
  // All targets checked. Conditional retirement preserves concurrent legacy
  // writes; the SQL drop guard will reject any source that changed meanwhile.
  for (const row of rows) await source.prepare("UPDATE runtime_resource_fences SET publication_json = NULL WHERE scope_key = ? AND publication_json = ? AND publication_generation = ? AND revision = ?")
    .bind(row.scope_key, row.publication_json, row.publication_generation, row.revision).run();
  const remaining = await source.prepare("SELECT count(*) AS n FROM runtime_resource_fences WHERE publication_json IS NOT NULL").first<{ n: number }>();
  if (Number(remaining?.n) !== 0) throw new Error("Work publication coverage changed during backfill; refusing retirement");
  return { copied, verified: rows.length };
}
