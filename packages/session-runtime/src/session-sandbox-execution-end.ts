// The end of a Session execution (design §0.1 steps 7 and 9, §0.0 rule 16):
//   - endExecution: egress.revoke("completed") (a failure is only a
//     warning) → storage.sync("turn_end") → the handle is recorded → a
//     changed sandbox is snapshotted (session-sandbox-snapshot) → the idle
//     pause is armed. The sandbox keeps running; the next execution
//     attaches to it.
//   - failExecution: nothing is published; egress.revoke("failed") (a
//     warning), the lose transition (forgets the handle and the pause point
//     that named it), release; the next execution starts from the latest
//     snapshot (session-sandbox-open), else fresh when nothing needs one.
// A lost fence (isCurrent false) exits without writing back or releasing.
// Record writes are compare-and-set (design §0.0b A.10): when another
// writer changed the record, endExecution drops its record and snapshot
// (the sandbox is left to the record's owner), and failExecution releases
// only a sandbox the winner's record does not name.

import { armIdle, disarmIdle } from "./session-sandbox-idle-pause";
import { errorText, sameHandle, type LiveSessionSandbox } from "./session-sandbox-live";
import { recordedHandle } from "./session-sandbox-state";
import { takeSnapshot } from "./session-sandbox-snapshot";
import { revokeEgress, syncStorage } from "./session-sandbox-storage-egress";

export async function endExecution<R>(state: LiveSessionSandbox<R>): Promise<void> {
  await state.quiesce();
  if (!await state.isCurrent(state.execution())) {
    state.abandon();
    return;
  }
  if (state.current !== null) await revokeEgress(state, state.current, "completed");
  await syncStorage(state, "turn_end");
  if (state.current !== null) {
    const record = await state.record(state.current);
    if (record === null) state.current = null;
    else await takeSnapshot(state, state.current, state.execution(), record);
  }
  // Old allocation cleanup is maintenance, never part of publishing/using
  // this turn's runtime. Bounded and single-flight, with pending kept durably.
  await armIdle(state, state.options.idle?.pauseMs ?? 0);
  // Maintenance owns its bounded wait; its initial DB read is inside it too.
  void state.load().then(record => state.retryReleases(record)).catch(error =>
    state.options.warn(`sandbox_release_failed error=${errorText(error)}`));
}

export async function failExecution<R>(state: LiveSessionSandbox<R>): Promise<void> {
  await state.quiesce();
  await disarmIdle(state);
  if (!await state.isCurrent(state.execution())) {
    state.abandon();
    return;
  }
  const open = state.current;
  // A persisted handle is discovery, not ownership by this attempt. Failed
  // opens already roll back their own resources; never adopt a winner here.
  if (open === null) return;
  // Retain the local owner until physical release confirms cleanup.
  state.lost = false;
  state.refreshError = null;
  if (open !== null) await revokeEgress(state, open, "failed");
  const saved = await state.load();
  const recorded = recordedHandle(saved);
  state.dirty = false;
  // The record names another sandbox: its writer holds it; only ours goes.
  if (recorded !== undefined && !sameHandle(recorded, open.handle)) {
    await state.releaseOwn(open.handle);
    state.current = null;
    return;
  }
  // Forget the handle first; release only once the record no longer names it.
  if (recorded !== undefined && await state.apply(saved, { type: "lose", retire: true }) === null) {
    if (open !== null) await state.releaseOwn(open.handle);
    state.current = null;
    return;
  }
  const handle = open?.handle ?? recorded;
  if (handle !== undefined) {
    // Retirement is durable before external deletion, including transport failures.
    const retired = await state.load();
    // This attempt owns the handle: wait for the real cleanup outcome. An
    // unconfirmed managed exit rejects before the local owner is dropped.
    const entry = retired.retiredHandles?.find(item => sameHandle(item.handle, handle));
    if (entry === undefined) await state.releaseOwn(handle);
    else if (!entry.released) await state.releaseRetiredOwned(retired, handle);
    else await state.retryReleases(retired);

    state.current = null;
    await state.retryDiscards();
  }
}
