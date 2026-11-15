import { buildWorkBootstrapRoutes } from "@open-managed-agents/http-routes";
import { authenticateWorkFinalizationBearer } from "@open-managed-agents/managed-agents-adapters-runtime";
import { SqlWorkBootstrap, SqlWorkFinalization } from "@open-managed-agents/managed-agents-adapters-sql";
import { WorkBootstrapApplication } from "@open-managed-agents/managed-agents-application";
import type { NodeRuntime } from "./node-runtime.js";
export function nodeWorkBootstrapRoutes(runtime:NodeRuntime){
 const {sql,dialect,managedEnvironmentWorkSessionTokenCrypto,managedEnvironmentWorkStore}=runtime;
 return buildWorkBootstrapRoutes({
  authenticate:async(token,method,path)=>managedEnvironmentWorkSessionTokenCrypto===null?null:authenticateWorkFinalizationBearer({token,method,path,crypto:managedEnvironmentWorkSessionTokenCrypto,now:()=>new Date(),find:claim=>managedEnvironmentWorkStore.find(claim)}),
  applicationFor:async()=>new WorkBootstrapApplication({persistence:new SqlWorkBootstrap(sql,{dialect}),finalization:new SqlWorkFinalization(sql,{dialect})}),
 });
}
