// The idle pause (design §0.1 step 8, §0.0 rule 11, §0.0b A.10). Execution
// end arms the host's timer `idle.pauseMs` out; nothing in the window moves
// it (background calls, keepAlive and alarms do not); an execution that
// starts in it takes the sandbox back (disarm). Nothing renews the provider
// lease in the window, and the lease (≥ idlePauseMs + margin) outlasts it,
// so the provider stops the sandbox itself if this pause never runs. The
// pause runs only with no execution (state.execution() === undefined). The
// core pauses at the deadline itself; the provider's own idle reclaim is
// set longer and is only a backstop. When it fires: skipped
// while an execution runs or the window was renewed; otherwise
// storage.sync("before_stop") → a changed sandbox is snapshotted →
// storage.detach → isCurrent → sandbox.pause → the idlePause transition. A
// pause in place (kind "self", E2B) becomes the pause point next to the
// latest snapshot; a provider without pause snapshots instead (kind
// "snapshot", Cloudflare: backup then stop), and that ref is also the latest
// snapshot. A replaced snapshot is discarded by the transition. A lost fence
// exits without pausing; a sandbox the provider already stopped is left alone.
// Only a running record pauses, and every write is a compare-and-set against
// the record read when the pause started (design §0.0b A.10): when another
// writer won, the pause is skipped and its ref discarded, the winner's record
// left as it is.
// A timer is cancelled by the host when a window closes, so one that fires
// on a fresh instance (no window, nothing open: the instance that armed it
// was evicted, e.g. a Cloudflare DO alarm) means its window ran out.

import type { SandboxHandle, SandboxPlan } from "@open-managed-agents/sandbox";
import { errorText, mergeStores, type LiveSessionSandbox } from "./session-sandbox-live";
import { takeSnapshot } from "./session-sandbox-snapshot";

export async function armIdle<R>(state: LiveSessionSandbox<R>, delayMs: number): Promise<void> {
  const idle = state.options.idle;
  if (idle === undefined) return;
  state.idleSince = state.now();
  state.idleVersion = (await state.load()).version;
  await idle.schedule(delayMs);
  state.options.info?.(`sandbox_idle_started pause_in_ms=${delayMs}`);
}

export async function disarmIdle<R>(state: LiveSessionSandbox<R>): Promise<void> {
  if (state.idleSince === null) return;
  state.idleSince = null;
  await Promise.resolve(state.options.idle?.cancel()).catch(() => undefined);
}

/** The idle timer fired. */
export async function idlePause<R>(state: LiveSessionSandbox<R>): Promise<"paused" | "skipped"> {
  const idle = state.options.idle;
  await state.quiesce();
  if (idle === undefined) return "skipped";
  if (state.idleSince === null) {
    if (state.current !== null) return "skipped";
    state.idleSince = state.now() - idle.pauseMs;
  }
  if (state.execution() !== undefined) {
    state.idleSince = null;
    return "skipped";
  }
  // Only an early fire waits; calls in flight do not hold the pause off.
  const remaining = state.idleSince + idle.pauseMs - state.now();
  if (remaining > 0) {
    await idle.schedule(remaining);
    return "skipped";
  }
  state.idleSince = null;
  const { ports } = await state.compose();
  const scope = state.scope();
  const signal = new AbortController().signal;
  const saved = await state.load();
  // Only a running sandbox pauses: a second fire, or a record moved on.
  if (saved.phase !== "running" || (state.idleVersion !== null && saved.version !== state.idleVersion)) return "skipped";
  const open = state.current;
  let target: { runtime: R; handle: SandboxHandle; outputs: SandboxPlan["outputs"] } | null = open === null ? null
    : { runtime: open.runtime, handle: open.handle, outputs: open.plan.outputs };
  if (target === null) {
    const attached = await ports.sandbox.attach({ scope, handle: saved.handle, signal });
    if (attached === "gone") return "skipped";
    state.stores = mergeStores(saved.stores, state.stores);
    state.outputs ||= saved.outputs;
    const plan = await state.options.plan({ scope, generation: "", stores: state.stores });
    target = { ...attached, outputs: plan.outputs };
  }
  if (state.attachesStorage) {
    await ports.storage.sync({ runtime: target.runtime, scope, fence: state.fence(scope), stores: state.stores, outputs: target.outputs, reason: "before_stop", signal });
  }
  const snapshotted = await takeSnapshot(state, target, undefined, saved);
  if (snapshotted === "conflict") return "skipped";
  await ports.storage.detach({ runtime: target.runtime, scope });
  const expected = snapshotted ?? saved;
  const current = await state.load();
  if (current.version !== expected.version || !await state.isCurrent(undefined) || state.execution() !== undefined) {
    state.abandon();
    return "skipped";
  }
  state.current = null;
  const ref = await ports.sandbox.pause({ scope, runtime: target.runtime, handle: target.handle, signal });
  // Not recorded, so nobody references it; discard never deletes the sandbox.
  const drop = () => ports.sandbox.discard({ scope, ref }).catch((error) => state.options.warn(`sandbox_discard_failed ref=${ref.ref} error=${errorText(error)}`));
  if (!await state.isCurrent(undefined) || state.execution() !== undefined) {
    await drop();
    return "skipped";
  }
  if (await state.apply(snapshotted ?? saved, { type: "idlePause", pauseRef: ref }) === null) {
    await drop();
    return "skipped";
  }
  state.options.info?.(`sandbox_idle_paused runtime=${target.handle.runtimeId} ref=${ref.ref} kind=${ref.kind}`);
  return "paused";
}
