// Renewals at exec boundaries (design §0.1 step 5; Workers cannot keep a
// timer), single-flight, a failure fails the call:
//   - storage.sync("interval") every STORAGE_SYNC_INTERVAL_MS (write back
//     only; native mounts use it to renew temporary credentials);
//   - sandbox.keepAlive every `keepAliveMs` (a provider lease); "gone"
//     marks the sandbox lost;
//   - egress.attach again every `egressRenewMs` (an expiring credential such
//     as the E2B relay pass), when the execution changed, or after a revoke.
// renewActivityTimeout is the host's own keepAlive (the Cloudflare alarm).

import { SandboxGoneError } from "@open-managed-agents/sandbox";
import { touchIdle } from "./session-sandbox-idle-pause";
import type { LiveSessionSandbox, OpenSandbox } from "./session-sandbox-live";
import { attachEgress } from "./session-sandbox-storage-egress";

/** Interval write-back at exec boundaries (design §0.1 step 5, default 15 s). */
export const STORAGE_SYNC_INTERVAL_MS = 15_000;

export function renewAtExecBoundary<R>(state: LiveSessionSandbox<R>, open: OpenSandbox<R>): Promise<void> {
  return state.maintaining ??= (async () => {
    const now = state.now();
    const { ports } = await state.compose();
    const scope = state.scope();
    const signal = new AbortController().signal;
    if (now - state.storageSyncedAt >= STORAGE_SYNC_INTERVAL_MS && state.attachesStorage) {
      await ports.storage.sync({ runtime: open.runtime, scope, fence: state.fence(scope), stores: state.stores, outputs: open.plan.outputs, reason: "interval", signal });
      state.storageSyncedAt = now;
    }
    const keepAliveMs = state.options.keepAliveMs ?? null;
    if (keepAliveMs !== null && now - state.keptAliveAt >= keepAliveMs) {
      if (await ports.sandbox.keepAlive(open) === "gone") {
        state.markLost();
        throw new SandboxGoneError("The sandbox is gone");
      }
      state.keptAliveAt = now;
    }
    const renew = state.options.egressRenewMs;
    const keyChanged = state.egressKey() !== state.egressAttachedKey;
    if ((renew !== null && now - state.egressAttachedAt >= renew) || keyChanged || state.egressRevoked) {
      const plan = await state.options.plan({ scope, generation: open.generation, stores: state.stores });
      await attachEgress(state, open, plan.egress, now, signal);
    }
  })().finally(() => { state.maintaining = null; });
}

/** keepAlive on the open sandbox (then the exec-boundary renewals), else on
 * the recorded one (an alarm-only wake keeps a background task's sandbox
 * alive). A paused one stays paused. */
export async function renewActivityTimeout<R>(state: LiveSessionSandbox<R>): Promise<void> {
  const { ports } = await state.compose();
  await state.quiesce();
  touchIdle(state);
  const open = state.current;
  if (open !== null) {
    if (await ports.sandbox.keepAlive(open) === "gone") {
      state.markLost();
      return;
    }
    await renewAtExecBoundary(state, open);
    return;
  }
  const saved = await state.options.state.load();
  if (saved?.handle === undefined || saved.paused === true) return;
  const attached = await ports.sandbox.attach({ scope: state.scope(), handle: saved.handle, signal: new AbortController().signal });
  if (attached !== "gone") await ports.sandbox.keepAlive(attached);
}
