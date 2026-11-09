// Snapshots while the Session runs (design §0.0 rule 11). The core keeps one
// snapshot apart from the pause point: a pause in place (E2B) is gone with
// the sandbox, so a sandbox the provider reclaimed (a kill, the 24 h cap) is
// started again from the latest snapshot instead.
//
// When: only after a call that may change the sandbox ran since the last
// snapshot (exec, process start, file writes; reads do not count) or while a
// duplex process it started (an ACP harness child) is alive, at every
// execution end, before the idle pause, and in a tool-call gap (the model is
// thinking) at most every `snapshotIntervalMs` (default SNAPSHOT_INTERVAL_MS);
// calls wait for a gap snapshot in progress.
//
// Publishing: sandbox.checkpoint → the fence check → the publishSnapshot
// transition (compare-and-set against the record read before, design §0.0b
// A.10), which discards the previous snapshot once it is written. A lost
// fence or a lost compare-and-set discards only the snapshot just taken. A
// failure is a warning; the Session keeps running. No published snapshot means
// the initial creation path is used again after loss, with a warning.

import type { ResumeRef, SandboxHandle } from "@open-managed-agents/sandbox";
import { errorText, sameHandle, type LiveSessionSandbox } from "./session-sandbox-live";
import type { SessionSandboxExecution } from "./session-sandbox-options";
import { isSnapshotRef, type SessionSandboxState, type SnapshotRef } from "./session-sandbox-state";

/** Tool-call-gap snapshot interval when the host sets none. */
export const SNAPSHOT_INTERVAL_MS = 5 * 60_000;

/** A changed sandbox whose last snapshot is older than the interval. */
export function snapshotDue<R>(state: LiveSessionSandbox<R>): boolean {
  return state.dirty && !state.snapshotsUnsupported && state.now() - state.snapshotAt >= (state.options.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS);
}

/** What a snapshot step left: the record after it (`expected` when nothing was
 * written; undefined when nothing was written and none was given), or
 * "conflict" when another writer changed the record first. */
export type SnapshotOutcome = SessionSandboxState | "conflict" | undefined;

/** In a tool-call gap, single-flight; calls wait for it (state.quiesce). */
export function snapshotInGap<R>(state: LiveSessionSandbox<R>, open: { runtime: R; handle: SandboxHandle }): Promise<void> {
  return state.snapshotting ??= takeSnapshot(state, open, state.execution()).then(() => undefined).finally(() => { state.snapshotting = null; });
}

/** Snapshot `open` if it changed since the last snapshot and publish it
 * under `execution`'s fence (undefined = between executions), against
 * `expected` (omitted = the record read before checkpointing). Never throws. */
export function takeSnapshot<R>(
  state: LiveSessionSandbox<R>,
  open: { runtime: R; handle: SandboxHandle },
  execution: SessionSandboxExecution | undefined,
  expected?: SessionSandboxState,
): Promise<SnapshotOutcome> {
  return state.checkpointing ??= checkpoint(state, open, execution, expected).finally(() => { state.checkpointing = null; });
}

async function checkpoint<R>(
  state: LiveSessionSandbox<R>,
  open: { runtime: R; handle: SandboxHandle },
  execution: SessionSandboxExecution | undefined,
  expected?: SessionSandboxState,
): Promise<SnapshotOutcome> {
  if (!state.dirty || state.snapshotsUnsupported) return expected;
  // Bind the checkpoint to the version AND sandbox observed before the vendor call.
  expected ??= await state.load();
  if (expected.phase !== "running" || !sameHandle(expected.handle, open.handle)) return "conflict";
  const { ports } = await state.compose();
  const scope = state.scope();
  // Calls during the snapshot mark the sandbox changed again; a live duplex
  // process keeps changing it after the snapshot.
  state.dirty = state.liveProcesses > 0;
  const started = state.now();
  let ref: ResumeRef;
  try {
    ref = await ports.sandbox.checkpoint({ scope, runtime: open.runtime, handle: open.handle, signal: new AbortController().signal });
  } catch (error) {
    state.dirty = true;
    state.options.warn(`sandbox_snapshot_failed runtime=${open.handle.runtimeId} error=${errorText(error)}`);
    return expected;
  }
  state.snapshotAt = state.now();
  if (!isSnapshotRef(ref)) {
    // Not a failed snapshot: this adapter has none (a bare v1 factory). Losing
    // the sandbox starts a new one with a warning, as without this core.
    state.snapshotsUnsupported = true;
    state.options.warn(`sandbox_snapshot_unsupported provider=${ref.provider}: the adapter's checkpoint returned the sandbox itself`);
    return expected;
  }
  const outcome = await publishSnapshot(state, ref, execution, expected);
  if (outcome !== "conflict" && outcome !== undefined && outcome !== expected) {
    state.options.info?.(`sandbox_snapshot_published ref=${ref.ref} runtime=${open.handle.runtimeId} elapsed_ms=${state.now() - started}`);
  }
  return outcome;
}

/** The publishSnapshot transition under the fence; a lost fence, a lost
 * compare-and-set or a failed write discards `ref` instead. */
export async function publishSnapshot<R>(
  state: LiveSessionSandbox<R>,
  ref: SnapshotRef,
  execution: SessionSandboxExecution | undefined,
  expected?: SessionSandboxState,
): Promise<SnapshotOutcome> {
  const { ports } = await state.compose();
  const discard = () => ports.sandbox.discard({ scope: state.scope(), ref })
    .catch((error) => state.options.warn(`sandbox_discard_failed ref=${ref.ref} error=${errorText(error)}`));
  try {
    if (!await state.isCurrent(execution)) {
      state.options.warn(`sandbox_snapshot_lost ref=${ref.ref}: the execution fence was lost; the snapshot is discarded`);
      await discard();
      return expected;
    }
    const saved = expected ?? await state.load();
    // Another writer moved the sandbox on: this snapshot has no place in its record.
    const next = saved.phase === "running" ? await state.apply(saved, { type: "publishSnapshot", ref }) : null;
    if (next === null) {
      await discard();
      return "conflict";
    }
    return next;
  } catch (error) {
    state.options.warn(`sandbox_snapshot_failed ref=${ref.ref} error=${errorText(error)}`);
    await discard();
    return expected;
  }
}

