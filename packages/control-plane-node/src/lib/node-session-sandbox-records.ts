// The Node Session sandbox handle records (design §0.0b A.8, A.10) in
// kv_entries (tenant = workspace, key = session_sandbox_state:<sessionId>,
// JSON value), so a restarted process finds its sandbox again by handle.
// Every save is a compare-and-set in one conditional statement: an UPDATE
// that matches the exact value read (which carries the version), or an
// INSERT that does nothing when a row already exists; meta.changes says
// whether this writer won. Portable across sqlite / pg / mysql (SqlClient).

import type { SqlClient } from "@open-managed-agents/sql-client";
import { stateVersion, type SessionSandboxState } from "@open-managed-agents/session-runtime";

/** Where a Session's handle record is kept: it must survive the process.
 * save is an atomic compare-and-set on the record's version (design §0.0b
 * A.10): false = the stored version is no longer `expected`. */
export interface NodeSessionSandboxRecords {
  load(workspaceId: string, sessionId: string): Promise<SessionSandboxState | undefined>;
  save(workspaceId: string, sessionId: string, state: SessionSandboxState, expected: number): Promise<boolean>;
}

const keyOf = (sessionId: string) => `session_sandbox_state:${sessionId}`;

export class SqlSessionSandboxRecords implements NodeSessionSandboxRecords {
  constructor(private readonly sql: SqlClient) {}

  async load(workspaceId: string, sessionId: string): Promise<SessionSandboxState | undefined> {
    const raw = await this.raw(workspaceId, sessionId);
    return raw === null ? undefined : JSON.parse(raw) as SessionSandboxState;
  }

  async save(workspaceId: string, sessionId: string, state: SessionSandboxState, expected: number): Promise<boolean> {
    const raw = await this.raw(workspaceId, sessionId);
    if (stateVersion(raw === null ? undefined : JSON.parse(raw) as SessionSandboxState) !== expected) return false;
    const value = JSON.stringify(state);
    const result = raw === null
      ? await this.sql.prepare(`INSERT INTO kv_entries (tenant_id, "key", value, expires_at) VALUES (?, ?, ?, NULL)
          ON CONFLICT (tenant_id, "key") DO NOTHING`).bind(workspaceId, keyOf(sessionId), value).run()
      : await this.sql.prepare(`UPDATE kv_entries SET value = ? WHERE tenant_id = ? AND "key" = ? AND value = ?`)
          .bind(value, workspaceId, keyOf(sessionId), raw).run();
    return result.meta.changes === 1;
  }

  private async raw(workspaceId: string, sessionId: string): Promise<string | null> {
    const row = await this.sql.prepare(`SELECT value FROM kv_entries WHERE tenant_id = ? AND "key" = ?`)
      .bind(workspaceId, keyOf(sessionId)).first<{ value: string }>();
    return row?.value ?? null;
  }
}
