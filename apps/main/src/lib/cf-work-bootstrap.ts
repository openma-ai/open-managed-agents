import { buildWorkBootstrapRoutes } from "@open-managed-agents/http-routes";
import { authenticateWorkFinalizationBearer } from "@open-managed-agents/managed-agents-adapters-runtime";
import { SqlWorkBootstrap, SqlWorkFinalization } from "@open-managed-agents/managed-agents-adapters-sql";
import { WorkBootstrapApplication } from "@open-managed-agents/managed-agents-application";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { Env } from "@open-managed-agents/shared";
export function cfWorkBootstrapRoutes(env:Env){
 const clientFor=async(workspaceId:string)=>new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(workspaceId));
 return buildWorkBootstrapRoutes({
  authenticate:async(token,method,path)=>{
   const root=env.PLATFORM_ROOT_SECRET;if(!root)return null;
   return authenticateWorkFinalizationBearer({token,method,path,crypto:new WebCryptoAesGcm(root,"managed.environment-work.session-token"),now:()=>new Date(),find:async claim=>{
    const cipher=new WebCryptoAesGcm(root,"managed.environment-work.secret");
    return new SqlEnvironmentWorkStore(await clientFor(claim.workspaceId),{seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)})}).find(claim);
   }});
  },
  applicationFor:async claim=>{const sql=await clientFor(claim.workspaceId);return new WorkBootstrapApplication({persistence:new SqlWorkBootstrap(sql),finalization:new SqlWorkFinalization(sql)});},
 });
}
