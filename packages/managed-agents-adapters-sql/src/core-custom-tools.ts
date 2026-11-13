import type { SqlClient } from '@open-managed-agents/sql-client';
import { CoreCustomToolMcp, CustomToolInvocations } from '@open-managed-agents/managed-agents-application';
import { SqlCustomToolInvocations } from './custom-tool-invocations';
import { SqlWorkFinalization } from './work-finalization';
import { SqlSessionSource } from './session-sql-source';

/** Called only with identity authenticated by the host's execution-token store.
 * Holder, definitions and canonical consumption are never supplied by MCP. */
export async function resolveSqlCoreCustomTools(sql: SqlClient, identity: {
  workspaceId:string; environmentId:string; sessionId:string; workId:string; generation:number;
}, turnId:string) {
  const work = await sql.prepare(`SELECT claim_worker_id FROM managed_environment_work
    WHERE workspace_id=? AND id=? AND session_id=? AND environment_id=? AND claim_generation=?`)
    .bind(identity.workspaceId,identity.workId,identity.sessionId,identity.environmentId,identity.generation)
    .first<{claim_worker_id:string}>();
  if (!work?.claim_worker_id) return null;
  const claim={...identity,holder:work.claim_worker_id};
  const state=await new SqlWorkFinalization(sql).inspect({claim,turnId});
  if (state.type!=='current' || !state.consumed || state.terminal!==null) return null;
  const session=await new SqlSessionSource(sql).find(identity);
  if (!session || session.archivedAt!==null) return null;
  const definitions=session.agent.tools.flatMap(tool => tool.type==='custom'
    ? [{name:tool.name,description:tool.description ?? '',input_schema:tool.inputSchema as Record<string,unknown>}] : []);
  return new CoreCustomToolMcp(new CustomToolInvocations(new SqlCustomToolInvocations(sql)),
    {...claim,turnId,canonicalRevision:state.revision},definitions);
}
