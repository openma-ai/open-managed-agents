import type { Env } from "@open-managed-agents/shared";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { authenticateWorkFinalizationBearer } from "@open-managed-agents/managed-agents-adapters-runtime";
import { managedMcpProxyFromWorkEnvironment } from "@open-managed-agents/acp-runtime/sandbox-agent";
import { sandboxTokenSha256 } from "@open-managed-agents/sandbox-gateway";

/** Derive holder/generation from the authenticated SQL Work, never caller env. */
export async function nativeWorkLaunchAuthority(env: Env, environment: Record<string, string>) {
  const delivery = managedMcpProxyFromWorkEnvironment(environment);
  const holderHash = await sandboxTokenSha256(environment.OPENMA_SANDBOX_TOKEN);
  if (!delivery || !holderHash || !env.PLATFORM_ROOT_SECRET) throw new Error("Native Work launch authority missing");
  const sql = new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(environment.OPENMA_WORKSPACE_ID));
  const cipher = new WebCryptoAesGcm(env.PLATFORM_ROOT_SECRET, "managed.environment-work.secret");
  const codec = new WebCryptoAesGcm(env.PLATFORM_ROOT_SECRET, "managed.environment-work.session-token");
  const work = new SqlEnvironmentWorkStore(sql, { seal: async ({ plaintext }) => ({ ciphertext: await cipher.encrypt(plaintext) }), open: async ({ ciphertext }) => ({ plaintext: await cipher.decrypt(ciphertext) }) });
  const auth = () => authenticateWorkFinalizationBearer({ token: delivery.sessionsToken, method: "POST", path: `/v1/oma/sessions/${encodeURIComponent(environment.ANTHROPIC_SESSION_ID)}/work-bootstrap`, crypto: codec, now: () => new Date(), find: c => work.find(c) });
  const claim = await auth();
  if (!claim || claim.workspaceId !== environment.OPENMA_WORKSPACE_ID || claim.sessionId !== environment.ANTHROPIC_SESSION_ID || claim.workId !== environment.ANTHROPIC_WORK_ID || claim.environmentId !== environment.ANTHROPIC_ENVIRONMENT_ID) throw new Error("Native Work launch scope mismatch");
  const assertCurrent = async () => {
    const current = await auth();
    if (!current || JSON.stringify(current) !== JSON.stringify(claim)) throw new Error("Native Work holder lost");
    const row = await sql.prepare("SELECT sandbox_token_hashes,state FROM managed_environment_work WHERE workspace_id=? AND id=? AND claim_generation=? AND claim_worker_id=?")
      .bind(claim.workspaceId, claim.workId, claim.generation, claim.holder).first<{ sandbox_token_hashes: string; state: string }>();
    const hashes: unknown = JSON.parse(row?.sandbox_token_hashes ?? "[]");
    if (!row || !["starting", "active"].includes(row.state) || !Array.isArray(hashes) || !hashes.some(h => h?.h === holderHash && h?.s === "all")) throw new Error("Native Work sandbox holder lost");
  };
  await assertCurrent();
  return { binding: { ...claim, holderHash }, assertCurrent };
}

/** Cold alarm authority uses the persisted exact holder, never a cached bearer
 * or a request closure. SQL errors propagate as unknown; no lease mutation. */
export async function nativeWorkProcessIsCurrent(env: Env, binding: import("./cf-native-work-process").NativeWorkProcess): Promise<boolean> {
  const sql = new CfD1SqlClient(await buildCfTenantDbProvider(env).resolve(binding.workspaceId));
  const row = await sql.prepare(`SELECT 1 AS current FROM managed_environment_work w
    JOIN managed_sessions s ON s.workspace_id=w.workspace_id AND s.id=w.session_id
    WHERE w.workspace_id=? AND w.environment_id=? AND w.session_id=? AND w.id=?
      AND w.claim_generation=? AND w.claim_worker_id=? AND w.state IN ('starting','active','stopping')
      AND w.claim_at+w.heartbeat_ttl_seconds*1000>(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))
      AND s.environment_id=w.environment_id AND s.archived_at IS NULL
      AND EXISTS(SELECT 1 FROM json_each(w.sandbox_token_hashes) h WHERE json_extract(h.value,'$.h')=? AND json_extract(h.value,'$.s')='all')`)
    .bind(binding.workspaceId, binding.environmentId, binding.sessionId, binding.workId, binding.generation, binding.holder, binding.holderHash).first();
  return row !== null;
}
