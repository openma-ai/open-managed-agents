import { WebCryptoAesGcm } from "@open-managed-agents/integrations-adapters-cf";
import { SqlEnvironmentWorkStore } from "@open-managed-agents/environment-work-store-sql";
import { sandboxIdlePauseMs } from "@open-managed-agents/session-runtime";
import { SANDBOX_LEASE_MARGIN_MS } from "@open-managed-agents/sandbox";
import { createCfE2BWorkLeaseAuthority } from "./cf-work-provider-lease";
import { readCfWorkLeaseRuntime } from "./cf-work-lease-connection";
import { restoreE2BWorkLeaseProcess } from "./e2b-work-handoff";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { SessionSandboxState } from "@open-managed-agents/session-runtime";
import type { SessionSandboxStateStorage } from "./session-sandbox-do-state";

/** Routing only, in the existing durable schedule. Never a claim or holder. */
export interface CfWorkLeaseScope {
  workspaceId: string;
  environmentId: string;
  sessionId: string;
}

/** Dispatch cannot reconstruct the original raw token for egress rebinding.
 * A recovered hash authorizes maintenance only. Do not rotate the holder by
 * replaying bootstrap: the existing alarm restores the exact native process.
 */
export async function checkCfWorkLeaseRecovery(input: {
  sql: SqlClient;
  storage: SessionSandboxStateStorage;
  scope: CfWorkLeaseScope;
}): Promise<void> {
  const record = input.storage.kv.get("e2b_sandbox_state") as SessionSandboxState | undefined;
  if (record?.phase !== "running" || record.handle.provider !== "e2b") return;
  const { workspaceId, environmentId, sessionId } = input.scope;
  const row = await input.sql.prepare(
    "SELECT id FROM managed_environment_work WHERE workspace_id=? AND environment_id=? AND session_id=? AND claim_generation > 0 LIMIT 1",
  ).bind(workspaceId, environmentId, sessionId).first<{ id: string }>();
  if (row) throw new Error("Work already has a sandbox record; recover maintenance through its durable alarm, not bootstrap");
}

/** Rebuild only native maintenance handles from the existing provider record,
 * trusted launch locator and SQL Work. No issuing tokens or starting processes.
 */
export async function recoverCfWorkLease(input: {
  sql: SqlClient;
  storage: SessionSandboxStateStorage;
  scope: CfWorkLeaseScope;
  env: import("./e2b-session-sandbox").E2BSandboxEnv & { PLATFORM_ROOT_SECRET?: string };
  lease: import("./cf-work-provider-lease").CfE2BWorkLease;
}): Promise<void> {
  const record = input.storage.kv.get("e2b_sandbox_state") as SessionSandboxState | undefined;
  if (record?.phase !== "running" || record.handle.provider !== "e2b") return;
  if (!input.env.PLATFORM_ROOT_SECRET || !input.env.PUBLIC_BASE_URL) throw new Error("Work lease recovery is not configured");
  const runtime = await readCfWorkLeaseRuntime(input.env, record.handle.runtimeId);
  const { locator, handle, generation, holderHash } = await restoreE2BWorkLeaseProcess({ runtime, scope: input.scope });
  const cipher = new WebCryptoAesGcm(input.env.PLATFORM_ROOT_SECRET, "managed.environment-work.secret");
  const work = new SqlEnvironmentWorkStore(input.sql, {
    seal: async ({ plaintext }) => ({ ciphertext: await cipher.encrypt(plaintext) }),
    open: async ({ ciphertext }) => ({ plaintext: await cipher.decrypt(ciphertext) }),
  });
  const location = { ...input.scope, workId: locator.identity.workId };
  const row = await work.find(location);
  // Unknown/mis-scoped data is not proof of loss. Do not signal the process.
  if (!row || row.work.data.type !== "session" || row.work.data.id !== input.scope.sessionId) throw new Error("Work lease SQL authority unknown");
  const observed = await input.sql.prepare("SELECT claim_generation FROM managed_environment_work WHERE workspace_id=? AND environment_id=? AND session_id=? AND id=?")
    .bind(input.scope.workspaceId, input.scope.environmentId, input.scope.sessionId, locator.identity.workId).first<{ claim_generation: number }>();
  if (!observed || observed.claim_generation < generation) throw new Error("Work lease SQL generation unknown");
  const apiBaseUrl = input.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  // Re-encode the already stored capability for the SAME authority function;
  // this does not mint a credential or infer a holder from the SQL hash set.
  const delivery = { ...location, apiBaseUrl, workSecret: btoa(JSON.stringify({ sessions_token: row.secret.sessionsToken, api_base_url: apiBaseUrl, claim_generation: generation })) };
  const authority = createCfE2BWorkLeaseAuthority({ sql: input.sql, work, delivery, generation, holderHash });
  input.lease.register({ runtime, handle, identity: locator.identity,
    ttlMs: sandboxIdlePauseMs(input.env.SANDBOX_IDLE_PAUSE_MS) + SANDBOX_LEASE_MARGIN_MS,
    isCurrent: async () => {
      const current = input.storage.kv.get("e2b_sandbox_state") as SessionSandboxState | undefined;
      return current?.phase === "running" && current.handle.provider === "e2b"
        && current.handle.runtimeId === locator.sandboxId && await authority();
    },
  });
}
