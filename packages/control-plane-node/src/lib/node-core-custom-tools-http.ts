import { buildCoreCustomToolsRoutes } from '@open-managed-agents/http-routes';
import { authenticateSandboxToken } from '@open-managed-agents/sandbox-gateway';
import { createSqlEnvironmentWorkSandboxTokenStore } from '@open-managed-agents/sandbox-gateway-sql';
import { resolveSqlCoreCustomTools } from '@open-managed-agents/managed-agents-adapters-sql';
import type { SqlClient } from '@open-managed-agents/sql-client';

export function nodeCoreCustomToolsHttp(sql: SqlClient, dialect: string) {
  const tokens=createSqlEnvironmentWorkSandboxTokenStore(sql);
  return buildCoreCustomToolsRoutes({authorize:async({token,sessionId,turnId})=>{
    const checked=await authenticateSandboxToken(tokens,{sessionId,token,channel:'api'});
    if(checked.type==='unavailable') throw new Error('Execution authority unavailable');
    if(checked.type!=='accepted') return null;
    // SQLite authority is implemented; do not accidentally execute its clock
    // fence on another dialect or pretend those unverified engines are ready.
    if(dialect!=='sqlite') throw new Error('Core custom tools SQL dialect unavailable');
    return resolveSqlCoreCustomTools(sql,checked.resolution,turnId);
  }});
}
