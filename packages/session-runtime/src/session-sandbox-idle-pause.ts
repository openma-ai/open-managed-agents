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
// storage.detach → isCurrent → sandbox.pause. A pause in place (kind
// "self", E2B) is recorded as the pause point next to the latest snapshot;
// a provider without pause snapshots instead (kind "snapshot", Cloudflare:
// backup then stop), which becomes the latest snapshot. A replaced ref is
// discarded. A lost fence exits without pausing; a sandbox the provider
// already stopped is left alone. The snapshot and the pause record are
// compare-and-set against the version read when the pause started (design
// §0.0b A.10): when another writer won, the pause is skipped and its ref
// discarded, the winner's record left as it is.
// A timer is cancelled by the host when a window closes, so one that fires
// on a fresh instance (no window, nothing open: the instance that armed it
// was evicted, e.g. a Cloudflare DO alarm) means its window ran out.

import type { SandboxHandle, SandboxPlan } from "@open-managed-agents/sandbox";
import { errorText, mergeStores, restorePoints, sameRef, stateVersion, type LiveSessionSandbox } from "./session-sandbox-live";
import { takeSnapshot } from "./session-sandbox-snapshot";

export async function armIdle<R>(state: LiveSessionSandbox<R>, delayMs: number): Promise<void> {
  const idle = state.options.idle;
  if (idle === undefined) return;
  state.idleSince = state.now();
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
  const saved = await state.options.state.load();
  let version = stateVersion(saved);
  const open = state.current;
  let target: { runtime: R; handle: SandboxHandle; outputs: SandboxPlan["outputs"] } | null = open === null ? null
    : { runtime: open.runtime, handle: open.handle, outputs: open.plan.outputs };
  if (target === null) {
    if (saved?.handle === undefined || saved.paused === true) return "skipped";
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
  const snapshotted = await takeSnapshot(state, target, undefined, version);
  if (snapshotted === "conflict") return "skipped";
  version = snapshotted ?? version;
  await ports.storage.detach({ runtime: target.runtime, scope });
  if (!await state.isCurrent(undefined)) {
    state.abandon();
    return "skipped";
  }
  state.current = null;
  const ref = await ports.sandbox.pause({ scope, runtime: target.runtime, handle: target.handle, signal });
  // Not recorded, so nobody references it; discard never deletes the sandbox.
  const drop = () => ports.sandbox.discard({ scope, ref }).catch((error) => state.options.warn(`sandbox_discard_failed ref=${ref.ref} error=${errorText(error)}`));
  if (!await state.isCurrent(undefined)) {
    await drop();
    return "skipped";
  }
  // Re-read: the snapshot above may have replaced the latest one.
  const latest = await state.options.state.load();
  const points = restorePoints(latest);
  const replaced = ref.kind === "snapshot" ? [points.snapshotRef, points.resumeRef] : [points.resumeRef];
  const next = ref.kind === "snapshot"
    ? { ...(points.restoreRequired === true ? { restoreRequired: true } : {}), snapshotRef: ref }
    : { ...points, resumeRef: ref };
  if (!await state.commit({ handle: target.handle, stores: state.stores, outputs: state.outputs, ...next, paused: true }, version)) {
    await drop();
    return "skipped";
  }
  for (const previous of replaced) {
    if (previous === undefined || sameRef(previous, ref)) continue;
    await ports.sandbox.discard({ scope, ref: previous }).catch((error) => state.options.warn(`sandbox_discard_failed ref=${previous.ref} error=${errorText(error)}`));
  }
  state.options.info?.(`sandbox_idle_paused runtime=${target.handle.runtimeId} ref=${ref.ref} kind=${ref.kind}`);
  return "paused";
}
