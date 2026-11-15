// Session rows for the SQL-backed sandbox token store suites (CF tenant D1,
// Node SQLite / PostgreSQL / MySQL): one seeding statement for every harness.

export interface SandboxGatewaySessionSeed {
  id: string;
  environmentId: string;
  vaultIds: string[];
  agent: { id: string; version: number };
  archivedAt: string | null;
}

/** Minimal SqlClient shape, so SQL harnesses share one seeding statement. */
interface SeedSql {
  prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
}

/** Writes the managed_sessions and managed_environments rows the sandbox
 * token store reads. */
export async function seedSandboxGatewaySessionRows(sql: SeedSql, workspaceId: string, session: SandboxGatewaySessionSeed & { document?: Record<string, unknown> }): Promise<void> {
  const createdAt = Date.UTC(2026, 10, 8);
  const archivedAt = session.archivedAt === null ? null : Date.parse(session.archivedAt);
  await sql.prepare(
    `INSERT INTO managed_environments (workspace_id, id, document, revision, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, 1, ?, ?, NULL)`,
  ).bind(workspaceId, session.environmentId, JSON.stringify({ id: session.environmentId, name: "env", config: { type: "cloud" } }), createdAt, createdAt).run();
  const document = { id: session.id, environmentId: session.environmentId, vaultIds: session.vaultIds, agent: { ...session.agent, name: "agent" }, ...session.document };
  await sql.prepare(
    `INSERT INTO managed_sessions (workspace_id, id, document, revision, agent_id, agent_version, environment_id, status, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, 'idle', ?, ?, ?)`,
  ).bind(workspaceId, session.id, JSON.stringify(document), session.agent.id, session.agent.version, session.environmentId, createdAt, createdAt, archivedAt).run();
}
