import { buildWorkFinalizationRoutes } from "@open-managed-agents/http-routes";
import { authenticateWorkFinalizationBearer } from "@open-managed-agents/managed-agents-adapters-runtime";
import { SqlWorkFinalization } from "@open-managed-agents/managed-agents-adapters-sql";
import { WorkFinalizationApplication, type WorkFinalizationHostPort } from "@open-managed-agents/managed-agents-application";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import type { Env } from "@open-managed-agents/shared";

/** Host injection must perform physical work through the existing authoritative
 * runtime. Absence is explicit 503, never a successful client assertion. */
export function cfWorkFinalizationRoutes(env:Env,host:WorkFinalizationHostPort = createCfWorkFinalizationHost(env)) {
  const clientFor=async(workspaceId:string)=>new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(workspaceId));
  return buildWorkFinalizationRoutes({
    authenticate:async(token,method,path)=>{
      const root=env.PLATFORM_ROOT_SECRET;if(!root)return null;
      return authenticateWorkFinalizationBearer({token,method,path,
        crypto:new WebCryptoAesGcm(root,"managed.environment-work.session-token"),now:()=>new Date(),
        find:async claim=>{
          const cipher=new WebCryptoAesGcm(root,"managed.environment-work.secret");
          return new SqlEnvironmentWorkStore(await clientFor(claim.workspaceId),{
            seal:async({plaintext})=>({ciphertext:await cipher.encrypt(plaintext)}),
            open:async({ciphertext})=>({plaintext:await cipher.decrypt(ciphertext)}),
          }).find(claim);
        },
      });
    },
    applicationFor:async claim=>new WorkFinalizationApplication({persistence:new SqlWorkFinalization(await clientFor(claim.workspaceId)),host}),
  });
}

/** Transport only: the DO reopens the sealed capability and resolves its own
 * physical resource. No request body claim, runtime id or receipt is authority. */
export function createCfWorkFinalizationHost(env: Env): WorkFinalizationHostPort {
  async function call(scope: import("@open-managed-agents/managed-agents-application").WorkFinalizationScope, phase: "prepare" | "publish", terminalEventId?: string) {
    if (!env.PLATFORM_ROOT_SECRET || !await scope.isCurrent()) throw new Error("Work finalization authority lost");
    const sql = new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(scope.claim.workspaceId));
    const cipher = new WebCryptoAesGcm(env.PLATFORM_ROOT_SECRET, "managed.environment-work.secret");
    const row = await new SqlEnvironmentWorkStore(sql, {
      seal: async ({ plaintext }) => ({ ciphertext: await cipher.encrypt(plaintext) }),
      open: async ({ ciphertext }) => ({ plaintext: await cipher.decrypt(ciphertext) }),
    }).find(scope.claim);
    if (!row || row.claim?.generation !== scope.claim.generation || row.claim.workerId !== scope.claim.holder) throw new Error("Work finalization holder changed");
    const path = `/__internal/work/finalization/${phase}`;
    const headers = { "content-type": "application/json", "x-oma-workspace-id": scope.claim.workspaceId, "x-oma-work-holder": scope.claim.holder, authorization: `Bearer ${row.secret.sessionsToken}` };
    const body = JSON.stringify({ turnId: scope.turnId, revision: scope.revision, ...(terminalEventId === undefined ? {} : { terminalEventId }) });
    const binding = (env as Env & { SANDBOX_sandbox_default?: Fetcher }).SANDBOX_sandbox_default;
    const response = binding
      ? await binding.fetch(`https://sandbox/sessions/${encodeURIComponent(scope.claim.sessionId)}${path}`, { method: "POST", headers, body })
      : env.SESSION_DO
        ? await env.SESSION_DO.get(env.SESSION_DO.idFromName(JSON.stringify([scope.claim.workspaceId, scope.claim.sessionId])))
          .fetch(new Request(`https://internal${path}`, { method: "POST", headers, body }))
        : null;
    if (response === null || response.status === 503) return { type: "unavailable" as const };
    if (!response.ok) throw new Error("Work finalization resource owner refused publication");
    const result = await response.json() as { type?: string };
    if (result.type !== (phase === "prepare" ? "prepared" : "published")) throw new Error("Invalid Work host acknowledgement");
    if (!await scope.isCurrent()) throw new Error("Work finalization authority changed during I/O");
    return phase === "prepare" ? { type: "prepared" as const } : { type: "published" as const };
  }
  return {
    prepare: async scope => { const result = await call(scope, "prepare"); if (result.type === "published") throw new Error("Wrong finalization phase"); return result; },
    publish: async scope => { const result = await call(scope, "publish", scope.terminal.eventId); if (result.type === "prepared") throw new Error("Wrong finalization phase"); return result; },
  };
}
