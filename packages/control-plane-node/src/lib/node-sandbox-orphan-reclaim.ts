// The Node orphan sandbox reclaim timer (design §0.0 rule 14): the shared
// job (session-runtime reclaimOrphanSandboxes) every SANDBOX_ORPHAN_RECLAIM_MS
// (default 5 minutes), like apps/matter's every(reconcileMs). Only with a
// Sandbox SDK v2 adapter: the v1 bridge holds its sandboxes in this process
// and lists none. The Session's recorded handle lives in process memory, so
// only ended (archived) Sessions are reclaimed; one tick at a time.

import type { SandboxLifecyclePort, SandboxPort } from "@open-managed-agents/sandbox";
import { reclaimOrphanSandboxes } from "@open-managed-agents/session-runtime";

export const DEFAULT_SANDBOX_ORPHAN_RECLAIM_MS = 5 * 60_000;

export function sandboxOrphanReclaimMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_SANDBOX_ORPHAN_RECLAIM_MS;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 1000) throw new Error(`SANDBOX_ORPHAN_RECLAIM_MS must be an integer of at least 1000 milliseconds, got ${JSON.stringify(value)}`);
  return ms;
}

/** Starts the timer; returns its stop function. */
export function startSandboxOrphanReclaim(input: {
  lifecycle: SandboxLifecyclePort<SandboxPort>;
  /** The Session's archived state; null = not found. */
  findSession(labels: { workspaceId: string; sessionId: string }): Promise<{ archivedAt: string | null } | null>;
  intervalMs: number;
  warn(fields: Record<string, unknown>, message: string): void;
}): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reclaimOrphanSandboxes({
        lifecycle: input.lifecycle as SandboxLifecyclePort<unknown>,
        session: async (labels) => {
          const session = await input.findSession(labels);
          return session === null ? null : { ended: session.archivedAt !== null };
        },
        now: Date.now,
        warn: (message) => input.warn({ op: "main-node.sandbox_orphan_reclaim" }, message),
      });
    } catch (error) {
      input.warn({ op: "main-node.sandbox_orphan_reclaim", err: error }, "sandbox orphan reclaim failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, input.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
