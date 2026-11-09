// Snapshots while the Session runs (design §0.0 rule 11). The core keeps one
// snapshot apart from the pause point: a pause in place (E2B) is gone with
// the sandbox, so a sandbox the provider reclaimed (a kill, the 24 h cap) is
// started again from the latest snapshot instead.
//
// When: only after a call that may change the sandbox ran since the last
// snapshot (exec, process start, file writes; reads do not count), at every
// execution end, before the idle pause, and in a tool-call gap (the model is
// thinking) at most every `snapshotIntervalMs` (default SNAPSHOT_INTERVAL_MS);
// calls wait for a gap snapshot in progress.
//
// Publishing: sandbox.checkpoint → the fence check → the handle record gets
// it as snapshotRef (and restoreRequired) by compare-and-set against the
// version read before (design §0.0b A.10) → only then the previous snapshot
// is discarded. A lost fence or a lost compare-and-set discards only the
// snapshot just taken. A failure is a warning; the Session keeps running
// and stays restoreRequired, so a later loss without any snapshot is an
// error, not an empty sandbox.

import type { ResumeRef, SandboxHandle } from "@open-managed-agents/sandbox";
import { errorText, restorePoints, sameRef, stateVersion, type LiveSessionSandbox } from "./session-sandbox-live";
import type { SessionSandboxExecution } from "./session-sandbox-options";

/** Tool-call-gap snapshot interval when the host sets none. */
export const SNAPSHOT_INTERVAL_MS = 5 * 60_000;

/** A changed sandbox whose last snapshot is older than the interval. */
export function snapshotDue<R>(state: LiveSessionSandbox<R>): boolean {
  return state.dirty && state.now() - state.snapshotAt >= (state.options.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS);
}

/** What a snapshot step left in the record: its version (unchanged when
 * nothing was written; undefined when nothing was written and no version
 * was given), or "conflict" when another writer changed the record first. */
export type SnapshotOutcome = number | "conflict" | undefined;

/** In a tool-call gap, single-flight; calls wait for it (state.quiesce). */
export function snapshotInGap<R>(state: LiveSessionSandbox<R>, open: { runtime: R; handle: SandboxHandle }): Promise<void> {
  return state.snapshotting ??= takeSnapshot(state, open, state.execution()).then(() => undefined).finally(() => { state.snapshotting = null; });
}

/** Snapshot `open` if it changed since the last snapshot and publish it
 * under `execution`'s fence (undefined = between executions), against
 * `expected` (omitted = the version read when publishing). Never throws. */
export async function takeSnapshot<R>(
  state: LiveSessionSandbox<R>,
  open: { runtime: R; handle: SandboxHandle },
  execution: SessionSandboxExecution | undefined,
  expected?: number,
): Promise<SnapshotOutcome> {
  if (!state.dirty) return expected;
  const { ports } = await state.compose();
  const scope = state.scope();
  // Calls during the snapshot mark the sandbox changed again.
  state.dirty = false;
  const started = state.now();
  let ref: ResumeRef;
  try {
    ref = await ports.sandbox.checkpoint({ scope, runtime: open.runtime, handle: open.handle, signal: new AbortController().signal });
  } catch (error) {
    state.dirty = true;
    state.options.warn(`sandbox_snapshot_failed runtime=${open.handle.runtimeId} error=${errorText(error)}`);
    return requireRestore(state, execution, expected);
  }
  state.snapshotAt = state.now();
  if (ref.kind !== "snapshot") {
    state.options.warn(`sandbox_snapshot_unsupported provider=${ref.provider}: the adapter's checkpoint returned the sandbox itself`);
    return requireRestore(state, execution, expected);
  }
  const outcome = await publishSnapshot(state, ref, execution, expected);
  if (typeof outcome === "number" && outcome !== expected) {
    state.options.info?.(`sandbox_snapshot_published ref=${ref.ref} runtime=${open.handle.runtimeId} elapsed_ms=${state.now() - started}`);
  }
  return outcome;
}

/** Records `ref` as the latest snapshot under the fence by compare-and-set,
 * then discards the previous one; a lost fence, a lost compare-and-set or a
 * failed record discards `ref` instead. */
export async function publishSnapshot<R>(
  state: LiveSessionSandbox<R>,
  ref: ResumeRef,
  execution: SessionSandboxExecution | undefined,
  expected?: number,
): Promise<SnapshotOutcome> {
  const { ports } = await state.compose();
  const scope = state.scope();
  const discard = async (target: ResumeRef) => {
    await ports.sandbox.discard({ scope, ref: target }).catch((error) => state.options.warn(`sandbox_discard_failed ref=${target.ref} error=${errorText(error)}`));
  };
  let previous: ResumeRef | undefined;
  let version: number;
  try {
    if (!await state.isCurrent(execution)) {
      state.options.warn(`sandbox_snapshot_lost ref=${ref.ref}: the execution fence was lost; the snapshot is discarded`);
      await discard(ref);
      return expected;
    }
    const saved = await state.options.state.load();
    version = expected ?? stateVersion(saved);
    previous = saved?.snapshotRef;
    const won = await state.commit({
      ...(saved ?? { stores: state.stores, outputs: state.outputs }),
      ...restorePoints(saved),
      snapshotRef: ref,
      restoreRequired: true,
    }, version);
    if (!won) {
      await discard(ref);
      return "conflict";
    }
  } catch (error) {
    state.options.warn(`sandbox_snapshot_failed ref=${ref.ref} error=${errorText(error)}`);
    await discard(ref);
    return expected;
  }
  if (previous !== undefined && !sameRef(previous, ref)) {
    await discard(previous);
    state.options.info?.(`sandbox_snapshot_discarded ref=${previous.ref} replaced_by=${ref.ref}`);
  }
  return version + 1;
}

/** No snapshot could be published, but the sandbox changed: losing it is an error from now on. */
async function requireRestore<R>(state: LiveSessionSandbox<R>, execution: SessionSandboxExecution | undefined, expected: number | undefined): Promise<SnapshotOutcome> {
  try {
    if (!await state.isCurrent(execution)) return expected;
    const saved = await state.options.state.load();
    const version = stateVersion(saved);
    if (expected !== undefined && version !== expected) return "conflict";
    if (saved === undefined || saved.restoreRequired === true) return version;
    return await state.commit({ ...saved, restoreRequired: true }, version) ? version + 1 : "conflict";
  } catch (error) {
    state.options.warn(`sandbox_snapshot_failed error=${errorText(error)}`);
    return expected;
  }
}
