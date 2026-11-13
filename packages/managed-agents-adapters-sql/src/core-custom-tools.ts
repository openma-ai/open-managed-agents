import type { SqlClient } from '@open-managed-agents/sql-client';
import { CoreCustomToolMcp, CustomToolInvocations, CustomInvocationConflict } from '@open-managed-agents/managed-agents-application';
import { SqlCustomToolInvocations } from './custom-tool-invocations';
import { SqlWorkFinalization } from './work-finalization';
import { SqlSessionSource } from './session-sql-source';

/** Called only with identity authenticated by the host's execution-token store.
 * Holder, definitions and canonical consumption are never supplied by MCP. */
export async function resolveSqlCoreCustomTools(sql: SqlClient, identity: {
  workspaceId:string; environmentId:string; sessionId:string; workId:string; generation:number;
}, turnId:string, dialect:'sqlite'|'postgres'|'mysql'='sqlite') {
  const work = await sql.prepare(`SELECT claim_worker_id FROM managed_environment_work
    WHERE workspace_id=? AND id=? AND session_id=? AND environment_id=? AND claim_generation=?`)
    .bind(identity.workspaceId,identity.workId,identity.sessionId,identity.environmentId,identity.generation)
    .first<{claim_worker_id:string}>();
  if (!work?.claim_worker_id) return null;
  const claim={...identity,holder:work.claim_worker_id};
  const read=async(view:SqlClient)=>{
    const persistence=new SqlWorkFinalization(view,{dialect});
    let state=await persistence.inspect({claim,turnId});
    for(let attempt=0;attempt<2 && state.type==='rejected' && state.reason==='authority_changed';attempt++){
      state=await persistence.inspect({claim,turnId});
    }
    if(state.type!=='current'||!state.consumed||state.terminal!==null)return null;
    const session=await new SqlSessionSource(view).find(identity);
    if(!session||session.archivedAt!==null)return null;
    const definitions=session.agent.tools.flatMap(tool=>tool.type==='custom'
      ?[{name:tool.name,description:tool.description??'',input_schema:tool.inputSchema as Record<string,unknown>}]:[]);
    return new CoreCustomToolMcp(new CustomToolInvocations(new SqlCustomToolInvocations(sql,{dialect})),
      {...claim,turnId,canonicalRevision:state.revision},definitions);
  };
  const inspect=async()=>{
    if(dialect==='sqlite')return read(sql);
    if(!sql.rowLockTransactions)throw Error('Core custom tools requires row-lock authority');
    return sql.rowLockTransactions.run(async tx=>{
      await tx.prepare('SELECT id FROM managed_sessions WHERE workspace_id=? AND id=? FOR UPDATE').bind(identity.workspaceId,identity.sessionId).first();
      await tx.prepare('SELECT id FROM managed_environment_work WHERE workspace_id=? AND id=? FOR UPDATE').bind(identity.workspaceId,identity.workId).first();
      return read({prepare:tx.prepare.bind(tx),batch:sql.batch.bind(sql),exec:sql.exec.bind(sql)});
    });
  };
  const initial=await inspect();
  if(!initial)return null;
  return {
    listTools:()=>initial.listTools(),
    async callTool(params:Parameters<CoreCustomToolMcp['callTool']>[0]){
      // Ordinary tool publication may advance the Session while MCP is in
      // flight. Retry only a rejected receipt INSERT (no effect was executed),
      // retaining the authenticated holder/generation and re-proving the root.
      for(let attempt=0;attempt<3;attempt++){
        const current=await inspect();
        if(!current)throw new CustomInvocationConflict();
        try{return await current.callTool(params);}
        catch(error){if(!(error instanceof CustomInvocationConflict)||attempt===2)throw error;}
      }
      throw new CustomInvocationConflict();
    },
  };
}
