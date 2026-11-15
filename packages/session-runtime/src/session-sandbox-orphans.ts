// Orphan sandbox reclaim (research/sandbox-sdk-v2-design.md §0.0 rule 14,
// §0.1 step 11), a scheduled job on each platform's timer (Cloudflare: the
// apps/main cron; Node: a process timer). Two parts:
//   - the orphan queue (sandboxes whose release failed) is drained by the
//     host's queue reconciler;
//   - for a provider whose handles change, sandboxes are listed by their
//     Session labels; one older than `minAgeMs` (past an acquire whose
//     handle was not recorded yet) is released when its Session ended, or
//     when the Session record names another sandbox. A sandbox whose
//     Session is unknown here (another deployment's, or a deleted Session
//     the platform no longer finds) is left alone.
// A "fixed" handle is derived from the Session id: re-acquiring reuses the
// same name, so there is nothing to list.

import type { SandboxHandle, SandboxLifecyclePort } from "@open-managed-agents/sandbox";

/** Default minimum age before a listed sandbox may be reclaimed. */
export const ORPHAN_SANDBOX_MIN_AGE_MS = 15 * 60_000;

export interface OrphanSandboxSession {
  ended: boolean;
  /** The Session's recorded sandbox; undefined = not recorded durably (not compared). */
  handle?: SandboxHandle | null;
}

export interface ReclaimOrphanSandboxesInput {
  /** The host's orphan queue reconciler (release failures). */
  queue?: { runOnce(input: { limit: number }): Promise<{ inspected: number; resolved: number }> };
  lifecycle?: Pick<SandboxLifecyclePort<unknown>, "handle" | "list" | "release">;
  /** The Session behind a sandbox's labels; null = unknown here. */
  session?(labels: { workspaceId: string; sessionId: string }): Promise<OrphanSandboxSession | null>;
  now(): number;
  minAgeMs?: number;
  queueLimit?: number;
  warn(message: string): void;
}

export interface ReclaimOrphanSandboxesResult {
  queue: { inspected: number; resolved: number };
  listed: number;
  released: number;
}

export async function reclaimOrphanSandboxes(input: ReclaimOrphanSandboxesInput): Promise<ReclaimOrphanSandboxesResult> {
  const queue = input.queue === undefined ? { inspected: 0, resolved: 0 } : await input.queue.runOnce({ limit: input.queueLimit ?? 100 });
  const result = { queue: { inspected: queue.inspected, resolved: queue.resolved }, listed: 0, released: 0 };
  const lifecycle = input.lifecycle;
  if (lifecycle === undefined || input.session === undefined || lifecycle.handle === "fixed") return result;
  const minAgeMs = input.minAgeMs ?? ORPHAN_SANDBOX_MIN_AGE_MS;
  const listed = await lifecycle.list({ labels: {}, signal: new AbortController().signal });
  result.listed = listed.length;
  for (const sandbox of listed) {
    const createdAt = Date.parse(sandbox.createdAt);
    if (!Number.isFinite(createdAt) || input.now() - createdAt < minAgeMs) continue;
    let session: OrphanSandboxSession | null;
    try {
      session = await input.session(sandbox.labels);
    } catch (error) {
      input.warn(`sandbox_orphan_lookup_failed runtime=${sandbox.handle.runtimeId} error=${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (session === null) continue;
    const replaced = session.handle !== undefined && session.handle?.runtimeId !== sandbox.handle.runtimeId;
    if (!session.ended && !replaced) continue;
    const scope = { workspaceId: sandbox.labels.workspaceId, sessionId: sandbox.labels.sessionId, environmentId: "", workId: sandbox.labels.sessionId };
    try {
      await lifecycle.release({ scope, handle: sandbox.handle });
      result.released += 1;
    } catch (error) {
      input.warn(`sandbox_orphan_release_failed runtime=${sandbox.handle.runtimeId} error=${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}
