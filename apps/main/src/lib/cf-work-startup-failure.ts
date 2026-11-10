import { buildWorkStartupFailureRoutes } from "@open-managed-agents/http-routes";
import { authenticateEnvironmentWorkSessionBearer } from "@open-managed-agents/managed-agents-adapters-runtime";
import { SqlSessionRuntimeProjectionPersistence } from "@open-managed-agents/managed-agents-adapters-sql";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { Env } from "@open-managed-agents/shared";

export function cfWorkStartupFailureRoutes(env: Env) {
  return buildWorkStartupFailureRoutes({
    authenticate: async (token, path) => {
      if (!env.PLATFORM_ROOT_SECRET) return null;
      const root = env.PLATFORM_ROOT_SECRET;
      return authenticateEnvironmentWorkSessionBearer({token,path,method:"POST",
        crypto:new WebCryptoAesGcm(root,"managed.environment-work.session-token"),now:()=>new Date(),
        isCurrent: async claim => {
          const sql = new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(claim.workspaceId));
          const cipher = new WebCryptoAesGcm(root,"managed.environment-work.secret");
          const store = new SqlEnvironmentWorkStore(sql,{
            seal:async ({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),
            open:async ({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)}),
          });
          const work = await store.find(claim);
          return work !== null && work.secret.sessionsToken === token &&
            work.work.data.type === "session" && work.work.data.id === claim.sessionId;
        },
      });
    },
    persistenceFor: async claim => new SqlSessionRuntimeProjectionPersistence(
      new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(claim.workspaceId)), { dialect: "sqlite" }),
  });
}
