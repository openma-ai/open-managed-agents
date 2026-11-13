import type { SqlClient } from '@open-managed-agents/sql-client';
import type { CustomInvocation, CustomInvocationPersistence, CustomInvocationScope } from '@open-managed-agents/managed-agents-application';

/** Internal receipt storage; not a second Session event log. Unbound receipts
 * are deliberately not client-visible actionable custom-tool events. */
export const customInvocationSchema = `CREATE TABLE managed_custom_invocations (
 workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, environment_id TEXT NOT NULL,
 turn_id TEXT NOT NULL, receipt TEXT NOT NULL, native_call_id TEXT,
 revision INTEGER NOT NULL, document TEXT NOT NULL,
 PRIMARY KEY(workspace_id,session_id,receipt)
);
CREATE UNIQUE INDEX idx_managed_custom_invocations_call ON managed_custom_invocations(workspace_id,session_id,turn_id,native_call_id)`;

/** SQLite/D1 implementation. Never auto-migrates at request time. Other SQL
 * engines must supply and verify their authority-lock implementation before
 * this path is enabled; a SQLite statement-clock fence is not a PG proof. */
export class SqlCustomToolInvocations implements CustomInvocationPersistence {
 constructor(private readonly sql: SqlClient) {}
 private fence(scope: CustomInvocationScope) {
  if (![scope.workspaceId,scope.sessionId,scope.environmentId,scope.workId,scope.holder,scope.turnId].every(v => typeof v === 'string' && v.length > 0) || !Number.isSafeInteger(scope.generation) || scope.generation < 1) throw new Error('Invalid custom invocation scope');
  return {
   sql: `EXISTS (SELECT 1 FROM managed_environment_work w JOIN managed_sessions s ON s.workspace_id=w.workspace_id AND s.id=w.session_id
    WHERE w.workspace_id=? AND w.session_id=? AND w.environment_id=? AND w.id=?
    AND s.environment_id=w.environment_id AND s.archived_at IS NULL
    ${scope.canonicalRevision === undefined ? "" : "AND s.revision=?"}
    AND w.state IN ('starting','active') AND w.claim_generation=? AND w.claim_worker_id=?
    AND w.claim_at + w.heartbeat_ttl_seconds * 1000 > (CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER)))`,
   bindings: [scope.workspaceId,scope.sessionId,scope.environmentId,scope.workId,...(scope.canonicalRevision === undefined ? [] : [scope.canonicalRevision]),scope.generation,scope.holder],
  };
 }
 async create(scope: CustomInvocationScope, invocation: CustomInvocation) {
  const fence=this.fence(scope);
  const result=await this.sql.prepare(`INSERT INTO managed_custom_invocations
   (workspace_id,session_id,environment_id,turn_id,receipt,native_call_id,revision,document)
   SELECT ?,?,?,?,?,?,?,? WHERE ${fence.sql}`)
   .bind(scope.workspaceId,scope.sessionId,scope.environmentId,scope.turnId,invocation.receipt,invocation.nativeCallId,invocation.revision,JSON.stringify(invocation),...fence.bindings).run();
  return result.meta.changes === 1;
 }
 async read(scope: CustomInvocationScope, receipt: string) {
  const fence=this.fence(scope);
  const row=await this.sql.prepare(`SELECT document FROM managed_custom_invocations WHERE workspace_id=? AND session_id=? AND environment_id=? AND turn_id=? AND receipt=? AND ${fence.sql}`)
   .bind(scope.workspaceId,scope.sessionId,scope.environmentId,scope.turnId,receipt,...fence.bindings).first<{document:string}>();
  return row ? JSON.parse(row.document) as CustomInvocation : null;
 }
 async replace(scope: CustomInvocationScope, before: CustomInvocation, after: CustomInvocation) {
  const fence=this.fence(scope);
  // The NOT EXISTS plus unique index rejects rebinding a native call to a
  // second receipt even when two identical-argument calls race concurrently.
  const result=await this.sql.prepare(`UPDATE managed_custom_invocations SET native_call_id=?,revision=?,document=?
   WHERE workspace_id=? AND session_id=? AND environment_id=? AND turn_id=? AND receipt=? AND revision=?
   AND NOT EXISTS (SELECT 1 FROM managed_custom_invocations other WHERE other.workspace_id=? AND other.session_id=? AND other.turn_id=? AND other.native_call_id=? AND other.receipt<>?)
   AND ${fence.sql}`)
   .bind(after.nativeCallId,after.revision,JSON.stringify(after),scope.workspaceId,scope.sessionId,scope.environmentId,scope.turnId,before.receipt,before.revision,
    scope.workspaceId,scope.sessionId,scope.turnId,after.nativeCallId,before.receipt,...fence.bindings).run();
  return result.meta.changes === 1;
 }
}
