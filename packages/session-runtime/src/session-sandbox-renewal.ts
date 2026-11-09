// Renewals at exec boundaries (design §0.1 step 5; Workers cannot keep a
// timer), single-flight, a failure fails the call:
//   - storage.sync("interval") every STORAGE_SYNC_INTERVAL_MS (write back
//     only; native mounts use it to renew temporary credentials);
//   - sandbox.keepAlive every `keepAliveMs` (a provider lease); "gone"
//     marks the sandbox lost;
//   - egress.attach again every `egressRenewMs` (an expiring credential such
//     as the E2B relay pass), when the execution changed, or after a revoke.
// renewActivityTimeout is the host's own heartbeat (the Node runner's lease
// heartbeat, the Cloudflare alarm).
//
// The provider lease is renewed only inside an execution (design §0.0b
// A.10). Idle activity (background processes, an alarm, a host heartbeat)
// never renews it and never moves the idle pause; work that must outlive
// the execution has to hold one. The lease is at least idlePauseMs +
// SANDBOX_LEASE_MARGIN_MS (checked at assembly), so a sandbox whose idle
// pause never runs stops on its own within the idle start + the lease.
// No lock and no correction: a renewal that races the execution end costs
// at most one more lease, or leaves an orphan for the orphan reclaim.

import { SandboxGoneError } from "@open-managed-agents/sandbox";
import type { LiveSessionSandbox, OpenSandbox } from "./session-sandbox-live";
import { attachEgress } from "./session-sandbox-storage-egress";
import { snapshotDue, snapshotInGap } from "./session-sandbox-snapshot";

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
    if (keepAliveMs !== null && now - state.keptAliveAt >= keepAliveMs) await renewLease(state, open);
    const renew = state.options.egressRenewMs;
    const keyChanged = state.egressKey() !== state.egressAttachedKey;
    if ((renew !== null && now - state.egressAttachedAt >= renew) || keyChanged || state.egressRevoked) {
      const plan = await state.options.plan({ scope, generation: open.generation, stores: state.stores });
      await attachEgress(state, open, plan.egress, now, signal);
    }
  })().finally(() => { state.maintaining = null; });
}

/** The host's heartbeat while an execution holds the open sandbox: keepAlive,
 * then the exec-boundary renewals (a long tool call makes no boundary; the
 * Cloudflare alarm is the only clock). Between executions, or with nothing
 * open, it does nothing: a recorded or paused sandbox is not attached and
 * not kept alive (design §0.0b A.10). */
export async function renewActivityTimeout<R>(state: LiveSessionSandbox<R>): Promise<void> {
  await state.quiesce();
  const open = state.current;
  if (open === null || state.execution() === undefined) return;
  try {
    await renewLease(state, open);
  } catch (error) {
    if (!(error instanceof SandboxGoneError)) throw error;
    return;
  }
  await renewAtExecBoundary(state, open);
  // ACP changes the sandbox through its duplex process, without facade calls.
  // Share the gap single-flight and configurable interval; never snapshot idle.
  if (state.current === open && state.execution() !== undefined && state.refreshing === null && snapshotDue(state)) await snapshotInGap(state, open);
}

/** sandbox.keepAlive inside an execution only; between executions the
 * renewal is dropped. "gone" marks the sandbox lost. */
export async function renewLease<R>(state: LiveSessionSandbox<R>, open: OpenSandbox<R>): Promise<"renewed" | "dropped"> {
  if (state.execution() === undefined) return "dropped";
  const { ports } = await state.compose();
  if (await ports.sandbox.keepAlive(open) === "gone") {
    state.markLost();
    throw new SandboxGoneError("The sandbox is gone");
  }
  state.keptAliveAt = state.now();
  return "renewed";
}
