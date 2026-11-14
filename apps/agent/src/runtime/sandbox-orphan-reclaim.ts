// Orphan sandbox reclaim on Cloudflare (research/sandbox-sdk-v2-design.md
// §0.0 rule 14): the apps/main cron calls this through the agent worker's
// service binding, because only this worker can reach the Sandbox Durable
// Objects. The shared job does both parts:
//   - drains the MAIN_DB orphan queue (releases that failed);
//   - on SANDBOX_ADAPTER=e2b ("changes" handle) lists the Session-labelled
//     sandboxes and releases those whose Session is archived. The Session
//     row is read from the tenant's database; a missing row or a failed read
//     releases nothing. The handle recorded in SessionDO storage is not read
//     here, so a sandbox replaced inside a live Session waits for the archive
//     (as on Node).
// The Cloudflare container adapter keeps a "fixed" handle (the DO name is the
// Session), so there is nothing to list.

import type { Env } from "@open-managed-agents/shared";
import { getCfServicesForTenant } from "@open-managed-agents/services";
import { reclaimOrphanSandboxes, type ReclaimOrphanSandboxesInput, type ReclaimOrphanSandboxesResult } from "@open-managed-agents/session-runtime";
import type { E2BV2Module } from "@open-managed-agents/sandbox-adapter-e2b/v2";
import { createCloudflareManagedRuntimeHost } from "./managed-runtime";
import { createE2BSandboxLifecycle, loadE2BModule } from "./e2b-session-sandbox";

export const SANDBOX_ORPHAN_RECLAIM_PATH = "/__internal/sandbox-orphans/reclaim";

export async function reclaimCloudflareOrphanSandboxes(
  env: Env,
  warn: (message: string) => void,
  deps: { e2b(): Promise<E2BV2Module> } = { e2b: loadE2BModule },
): Promise<ReclaimOrphanSandboxesResult> {
  if (!env.MAIN_DB) throw new Error("MAIN_DB binding is required for the sandbox orphan queue");
  const runtime = createCloudflareManagedRuntimeHost(env, { ownerId: "sandbox-orphan-reclaim" });
  const labelled: Pick<ReclaimOrphanSandboxesInput, "lifecycle" | "session"> = env.SANDBOX_ADAPTER === "e2b"
    ? { lifecycle: createE2BSandboxLifecycle(env, await deps.e2b()), session: (labels) => findSession(env, labels) }
    : {};
  return reclaimOrphanSandboxes({ queue: runtime.orphanReconciler, ...labelled, now: Date.now, warn });
}

/** The Session behind a sandbox's labels; null = not found here. Read errors propagate (the job skips the sandbox). */
async function findSession(env: Env, labels: { workspaceId: string; sessionId: string }): Promise<{ ended: boolean } | null> {
  const services = await getCfServicesForTenant(env, labels.workspaceId);
  const row = await services.sessions.get({ tenantId: labels.workspaceId, sessionId: labels.sessionId });
  return row === null ? null : { ended: row.archived_at !== null };
}
