// The idle pause (design §0.1 step 8, §0.0 rule 11). Execution end arms
// the host's timer `idle.pauseMs` out; any call or keepAlive in the window
// pushes it out. When it fires: skipped while an execution runs or the
// window was renewed; otherwise storage.sync("before_stop") →
// storage.detach → isCurrent → sandbox.pause → the new ResumeRef is recorded
// with the handle → the old ref is discarded when it differs. A lost fence
// exits without pausing; a sandbox the provider already stopped is left alone.

import type { SandboxHandle, SandboxPlan } from "@open-managed-agents/sandbox";
import { errorText, mergeStores, type LiveSessionSandbox } from "./session-sandbox-live";

export async function armIdle<R>(state: LiveSessionSandbox<R>, delayMs: number): Promise<void> {
  if (state.options.idle === undefined) return;
  state.idleSince = state.now();
  await state.options.idle.schedule(delayMs);
}

export async function disarmIdle<R>(state: LiveSessionSandbox<R>): Promise<void> {
  if (state.idleSince === null) return;
  state.idleSince = null;
  await Promise.resolve(state.options.idle?.cancel()).catch(() => undefined);
}

/** Activity during the idle window pushes the pause out. */
export function touchIdle<R>(state: LiveSessionSandbox<R>): void {
  if (state.idleSince !== null) state.idleSince = state.now();
}

/** The idle timer fired. */
export async function idlePause<R>(state: LiveSessionSandbox<R>): Promise<"paused" | "skipped"> {
  const idle = state.options.idle;
  await state.quiesce();
  if (idle === undefined || state.idleSince === null) return "skipped";
  if (state.execution() !== undefined) {
    state.idleSince = null;
    return "skipped";
  }
  const remaining = state.idleSince + idle.pauseMs - state.now();
  if (remaining > 0 || state.inFlight > 0) {
    await idle.schedule(Math.max(remaining, 1));
    return "skipped";
  }
  state.idleSince = null;
  const { ports } = await state.compose();
  const scope = state.scope();
  const signal = new AbortController().signal;
  const saved = await state.options.state.load();
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
  await ports.storage.detach({ runtime: target.runtime, scope });
  if (!await state.isCurrent(undefined)) {
    state.abandon();
    return "skipped";
  }
  state.current = null;
  const ref = await ports.sandbox.pause({ scope, runtime: target.runtime, handle: target.handle, signal });
  if (!await state.isCurrent(undefined)) {
    // Not recorded, so nobody references it; discard never deletes the sandbox.
    await ports.sandbox.discard({ scope, ref }).catch((error) => state.options.warn(`sandbox_discard_failed ref=${ref.ref} error=${errorText(error)}`));
    return "skipped";
  }
  await state.options.state.save({ handle: target.handle, stores: state.stores, outputs: state.outputs, resumeRef: ref, paused: true });
  const previous = saved?.resumeRef;
  if (previous !== undefined && (previous.provider !== ref.provider || previous.ref !== ref.ref)) {
    await ports.sandbox.discard({ scope, ref: previous }).catch((error) => state.options.warn(`sandbox_discard_failed ref=${previous.ref} error=${errorText(error)}`));
  }
  return "paused";
}
