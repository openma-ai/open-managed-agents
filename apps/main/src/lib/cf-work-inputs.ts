import { buildWorkInputRoutes } from "@open-managed-agents/http-routes";
import { authenticateWorkInputBearer } from "@open-managed-agents/managed-agents-adapters-runtime";
import { SqlWorkInputs } from "@open-managed-agents/managed-agents-adapters-sql";
import { WorkInputsApplication } from "@open-managed-agents/managed-agents-application";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { Env } from "@open-managed-agents/shared";

/** Private capability route: resolve the shard only from the sealed token,
 * then authenticate against its persisted Work. SQL repeats the fence. */
export function cfWorkInputRoutes(env: Env) {
  const clientFor = async (workspaceId: string) => new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(workspaceId));
  return buildWorkInputRoutes({
    authenticate: async (token, method, path) => {
      const root = env.PLATFORM_ROOT_SECRET;
      if (!root) return null;
      return authenticateWorkInputBearer({ token, method, path,
        crypto: new WebCryptoAesGcm(root, "managed.environment-work.session-token"), now: () => new Date(),
        find: async claim => {
          const cipher = new WebCryptoAesGcm(root, "managed.environment-work.secret");
          return new SqlEnvironmentWorkStore(await clientFor(claim.workspaceId), {
            seal: async ({plaintext}) => ({ciphertext: await cipher.encrypt(plaintext)}),
            open: async ({ciphertext}) => ({plaintext: await cipher.decrypt(ciphertext)}),
          }).find(claim);
        },
      });
    },
    // 0031_work_inputs validates canonical history; the reader verifies its
    // indexes on this shard before any page (unmigrated shards fail closed).
    applicationFor: async claim => new WorkInputsApplication(new SqlWorkInputs(await clientFor(claim.workspaceId), {
      sourcePositionsValidated: true, dialect: "sqlite",
    })),
  });
}
