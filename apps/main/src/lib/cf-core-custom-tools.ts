import { buildCoreCustomToolsRoutes } from '@open-managed-agents/http-routes';
import { authenticateSandboxToken, type SandboxTokenStore } from '@open-managed-agents/sandbox-gateway';
import { createSqlEnvironmentWorkSandboxTokenStore } from '@open-managed-agents/sandbox-gateway-sql';
import { resolveSqlCoreCustomTools } from '@open-managed-agents/managed-agents-adapters-sql';
import { CfD1SqlClient } from '@open-managed-agents/sql-client/adapters/cf-d1';
import { buildCfTenantDbProvider } from '@open-managed-agents/services';
import type { Env } from '@open-managed-agents/shared';
import { cfTenantDatabases } from './cf-sandbox-token-store';

export function cfCoreCustomToolsRoutes(env: Env) {
  const stores=cfTenantDatabases(env).map(db=>createSqlEnvironmentWorkSandboxTokenStore(new CfD1SqlClient(db)));
  // Only the Work lane can authorize this endpoint; MA execution tokens do
  // not become Work claims merely because they are valid on other gateways.
  const tokens:Pick<SandboxTokenStore,'find'>={find:async input=>{
    const found=(await Promise.all(stores.map(store=>store.find(input)))).filter(row=>row?.attempt!=null);
    if(found.length>1) throw new Error('Ambiguous Work authority');
    return found[0]??null;
  }};
  return buildCoreCustomToolsRoutes({authorize:async({token,sessionId,turnId})=>{
    const checked=await authenticateSandboxToken(tokens as SandboxTokenStore,{sessionId,token,channel:'api'});
    if(checked.type==='unavailable')throw new Error('Execution authority unavailable');
    if(checked.type!=='accepted')return null;
    const sql=new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(checked.session.workspaceId));
    return resolveSqlCoreCustomTools(sql,checked.resolution,turnId);
  }});
}
