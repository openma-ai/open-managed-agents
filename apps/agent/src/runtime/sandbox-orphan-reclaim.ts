// Orphan sandbox reclaim on Cloudflare (research/sandbox-sdk-v2-design.md
// §0.0 rule 14): the apps/main cron calls this through the agent worker's
// service binding, because only this worker can reach the Sandbox Durable
// Objects. It drains the MAIN_DB orphan queue (releases that failed) with
// the shared job. Session sandboxes have a "fixed" handle here (the DO name
// is the Session), so there is nothing to list.

import type { Env } from "@open-managed-agents/shared";
import { reclaimOrphanSandboxes, type ReclaimOrphanSandboxesResult } from "@open-managed-agents/session-runtime";
import { createCloudflareManagedRuntimeHost } from "./managed-runtime";

export const SANDBOX_ORPHAN_RECLAIM_PATH = "/__internal/sandbox-orphans/reclaim";

export async function reclaimCloudflareOrphanSandboxes(env: Env, warn: (message: string) => void): Promise<ReclaimOrphanSandboxesResult> {
  if (!env.MAIN_DB) throw new Error("MAIN_DB binding is required for the sandbox orphan queue");
  const runtime = createCloudflareManagedRuntimeHost(env, { ownerId: "sandbox-orphan-reclaim" });
  return reclaimOrphanSandboxes({ queue: runtime.orphanReconciler, now: Date.now, warn });
}
