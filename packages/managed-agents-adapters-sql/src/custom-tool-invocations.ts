import type { SqlClient, SqlTransaction } from '@open-managed-agents/sql-client';
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

/** MySQL's index budget cannot index a full 1024-character native call ID.
 * The digest uniqueness check fails closed on collisions; stored identity is
 * still compared as exact bytes and never recovered from a digest. */
export const customInvocationMysqlSchema = `CREATE TABLE managed_custom_invocations (
 workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
 session_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
 environment_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
 turn_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
 receipt VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 native_call_id VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
 native_call_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(native_call_id,256))) STORED,
 revision BIGINT NOT NULL, document LONGTEXT NOT NULL,
 PRIMARY KEY(workspace_id,session_id,receipt),
 UNIQUE KEY idx_managed_custom_invocations_call(workspace_id,session_id,turn_id,native_call_hash)
) ENGINE=InnoDB`;

/** Never auto-migrates at request time. SQLite/D1 uses atomic statement CAS;
 * PostgreSQL/MySQL require verified connection-bound authority locks.
 * Host exposure still requires canonical publication/admission dialect gates. */
export class SqlCustomToolInvocations implements CustomInvocationPersistence {
 constructor(private readonly sql: SqlClient, private readonly options: {dialect?: 'sqlite'|'postgres'|'mysql'} = {}) {}
 private get dialect() { return this.options.dialect ?? 'sqlite'; }
 private get clock() {
  return this.dialect === 'postgres' ? "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint"
   : this.dialect === 'mysql' ? "floor(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000)"
   : "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
 }
 /** READ COMMITTED authority locks precede the final statement-clock fence.
  * Lock ordering matches canonical Work inputs: Session, Work, then receipt.
  * A lock wait must never retain transaction-start lease authority. */
 private async authorized<T>(scope:CustomInvocationScope, rejected:T, operation:(tx:SqlTransaction)=>Promise<T>):Promise<T> {
  this.fence(scope); // validate before accessing any authority
  if(this.dialect==='sqlite')return operation(this.sql);
  const transactions=this.sql.rowLockTransactions;
  if(!transactions)throw Error('Custom invocation authority requires row-lock transactions');
  const capability=await transactions.capability(['managed_sessions','managed_environment_work','managed_custom_invocations']);
  if(!capability.supported)throw Error('Custom invocation row-lock authority unavailable: '+capability.reason);
  return transactions.run(async tx=>{
   const session=await tx.prepare('SELECT id FROM managed_sessions WHERE workspace_id=? AND id=? FOR UPDATE').bind(scope.workspaceId,scope.sessionId).first();
   if(!session)return rejected;
   const work=await tx.prepare('SELECT id FROM managed_environment_work WHERE workspace_id=? AND id=? FOR UPDATE').bind(scope.workspaceId,scope.workId).first();
   if(!work)return rejected;
   return operation(tx);
  });
 }
 private async lockReceipt(tx:SqlTransaction,scope:CustomInvocationScope,receipt:string) {
  if(this.dialect!=='sqlite')await tx.prepare('SELECT receipt FROM managed_custom_invocations WHERE workspace_id=? AND session_id=? AND receipt=? FOR UPDATE').bind(scope.workspaceId,scope.sessionId,receipt).first();
 }
 private exact(column:string) { return this.dialect==='mysql' ? `BINARY ${column}=BINARY ?` : `${column}=?`; }
 private same(left:string,right:string) { return this.dialect==='mysql' ? `BINARY ${left}=BINARY ${right}` : `${left}=${right}`; }
 private fence(scope: CustomInvocationScope) {
  if (![scope.workspaceId,scope.sessionId,scope.environmentId,scope.workId,scope.holder,scope.turnId].every(v => typeof v === 'string' && v.length > 0) || !Number.isSafeInteger(scope.generation) || scope.generation < 1) throw new Error('Invalid custom invocation scope');
  return {
   sql: `EXISTS (SELECT 1 FROM managed_environment_work w JOIN managed_sessions s ON ${this.same("s.workspace_id","w.workspace_id")} AND ${this.same("s.id","w.session_id")}
    WHERE ${this.exact("w.workspace_id")} AND ${this.exact("w.session_id")} AND ${this.exact("w.environment_id")} AND ${this.exact("w.id")}
    AND ${this.same("s.environment_id","w.environment_id")} AND s.archived_at IS NULL
    ${scope.canonicalRevision === undefined ? "" : "AND s.revision=?"}
    AND w.state IN ('starting','active') AND w.claim_generation=? AND ${this.exact("w.claim_worker_id")}
    AND w.claim_at + w.heartbeat_ttl_seconds * 1000 > ${this.clock})`,
   bindings: [scope.workspaceId,scope.sessionId,scope.environmentId,scope.workId,...(scope.canonicalRevision === undefined ? [] : [scope.canonicalRevision]),scope.generation,scope.holder],
  };
 }
 async create(scope: CustomInvocationScope, invocation: CustomInvocation) {
  const fence=this.fence(scope);
  return this.authorized(scope,false,async tx=>{
  const result=await tx.prepare(`INSERT INTO managed_custom_invocations
   (workspace_id,session_id,environment_id,turn_id,receipt,native_call_id,revision,document)
   SELECT ?,?,?,?,?,?,?,? WHERE ${fence.sql}`)
   .bind(scope.workspaceId,scope.sessionId,scope.environmentId,scope.turnId,invocation.receipt,invocation.nativeCallId,invocation.revision,JSON.stringify(invocation),...fence.bindings).run();
  return result.meta.changes === 1;
  });
 }
 async read(scope: CustomInvocationScope, receipt: string) {
  const fence=this.fence(scope);
  return this.authorized<CustomInvocation|null>(scope,null,async tx=>{
  await this.lockReceipt(tx,scope,receipt);
  const row=await tx.prepare(`SELECT document FROM managed_custom_invocations WHERE workspace_id=? AND session_id=? AND environment_id=? AND turn_id=? AND receipt=? AND ${fence.sql}`)
   .bind(scope.workspaceId,scope.sessionId,scope.environmentId,scope.turnId,receipt,...fence.bindings).first<{document:string}>();
  return row ? JSON.parse(row.document) as CustomInvocation : null;
  });
 }
 async replace(scope: CustomInvocationScope, before: CustomInvocation, after: CustomInvocation) {
  const fence=this.fence(scope);
  // The NOT EXISTS plus unique index rejects rebinding a native call to a
  // second receipt even when two identical-argument calls race concurrently.
  return this.authorized(scope,false,async tx=>{
  await this.lockReceipt(tx,scope,before.receipt);
  if(this.dialect!=='sqlite' && after.nativeCallId!==null) {
   const conflict=await tx.prepare('SELECT receipt FROM managed_custom_invocations WHERE workspace_id=? AND session_id=? AND turn_id=? AND native_call_id=? AND receipt<>?').bind(scope.workspaceId,scope.sessionId,scope.turnId,after.nativeCallId,before.receipt).first();
   if(conflict)return false;
  }
  const result=await tx.prepare(`UPDATE managed_custom_invocations SET native_call_id=?,revision=?,document=?
   WHERE workspace_id=? AND session_id=? AND environment_id=? AND turn_id=? AND receipt=? AND revision=?
   ${this.dialect==='sqlite'?'AND NOT EXISTS (SELECT 1 FROM managed_custom_invocations other WHERE other.workspace_id=? AND other.session_id=? AND other.turn_id=? AND other.native_call_id=? AND other.receipt<>?)':''}
   AND ${fence.sql}`)
   .bind(after.nativeCallId,after.revision,JSON.stringify(after),scope.workspaceId,scope.sessionId,scope.environmentId,scope.turnId,before.receipt,before.revision,
    ...(this.dialect==='sqlite'?[scope.workspaceId,scope.sessionId,scope.turnId,after.nativeCallId,before.receipt]:[]),...fence.bindings).run();
  return result.meta.changes === 1;
  });
 }
}

/** Additive native MySQL migration. Refuse an existing SQLite-shaped table or
 * a weakened identity index instead of treating IF NOT EXISTS as validation. */
export async function ensureMysqlCustomInvocationSchema(sql:SqlClient):Promise<void>{
 await sql.exec(customInvocationMysqlSchema.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
 const rows=(await sql.prepare("SELECT column_name AS name, data_type AS kind, character_maximum_length AS size, collation_name AS collation, generation_expression AS expression, extra AS extra FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='managed_custom_invocations'").all<{name:string;kind:string;size:number;collation:string;expression:string;extra:string}>()).results;
 const columns=new Map((rows??[]).map(row=>[row.name,row]));
 for(const [name,size,collation] of [
  ['workspace_id',191,'utf8mb4_bin'],['session_id',191,'utf8mb4_bin'],['environment_id',191,'utf8mb4_bin'],['turn_id',191,'utf8mb4_bin'],['receipt',36,'ascii_bin'],['native_call_id',1024,'utf8mb4_bin'],
 ] as const){const column=columns.get(name);if(column?.kind!=='varchar'||Number(column.size)!==size||column.collation!==collation)throw Error('Custom invocation migration: unexpected identity column '+name);}
 const digest=columns.get('native_call_hash');
 if(digest?.kind!=='binary'||Number(digest.size)!==32||!/STORED GENERATED/i.test(digest.extra)||digest.expression.replace(/[`\s]/g,'').toLowerCase()!=='unhex(sha2(native_call_id,256))')throw Error('Custom invocation migration: invalid native call digest');
 const indexes=(await sql.prepare("SELECT index_name AS name, MIN(non_unique) AS non_unique, GROUP_CONCAT(COALESCE(column_name,'<expression>') ORDER BY seq_in_index) AS columns, SUM(CASE WHEN sub_part IS NOT NULL THEN 1 ELSE 0 END) AS prefixes FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='managed_custom_invocations' GROUP BY index_name").all<{name:string;non_unique:number;columns:string;prefixes:number}>()).results;
 for(const [name,expected] of [['PRIMARY','workspace_id,session_id,receipt'],['idx_managed_custom_invocations_call','workspace_id,session_id,turn_id,native_call_hash']]){
  const index=(indexes??[]).find(row=>row.name===name);
  if(!index||Number(index.non_unique)!==0||index.columns!==expected||Number(index.prefixes)!==0)throw Error('Custom invocation migration: invalid identity index '+name);
 }
 const engine=await sql.prepare("SELECT engine AS engine FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='managed_custom_invocations'").first<{engine:string}>();
 if(engine?.engine!=='InnoDB')throw Error('Custom invocation migration requires InnoDB');
}
