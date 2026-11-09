// The end of a Session execution (design §0.1 steps 7 and 9, §0.0 rule 16):
//   - endExecution: egress.revoke("completed") (a failure is only a
//     warning) → storage.sync("turn_end") → the handle is recorded → a
//     changed sandbox is snapshotted (session-sandbox-snapshot) → the idle
//     pause is armed. The sandbox keeps running; the next execution
//     attaches to it.
//   - failExecution: nothing is published; egress.revoke("failed") (a
//     warning), release, forget the handle and the pause point (it named
//     the released sandbox); the next execution starts from the latest
//     snapshot (session-sandbox-open), else fresh when nothing needs one.
// A lost fence (isCurrent false) exits without writing back or releasing.
// Record writes are compare-and-set (design §0.0b A.10): when another
// writer changed the record, endExecution drops its record and snapshot
// (the sandbox is left to the record's owner), and failExecution releases
// only a sandbox the winner's record does not name.

import { armIdle, disarmIdle } from "./session-sandbox-idle-pause";
import { errorText, restorePoints, stateVersion, type LiveSessionSandbox } from "./session-sandbox-live";
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
    const version = await state.record(state.current);
    if (version === null) state.current = null;
    else await takeSnapshot(state, state.current, state.execution(), version);
  }
  await armIdle(state, state.options.idle?.pauseMs ?? 0);
}

export async function failExecution<R>(state: LiveSessionSandbox<R>): Promise<void> {
  await state.quiesce();
  await disarmIdle(state);
  if (!await state.isCurrent(state.execution())) {
    state.abandon();
    return;
  }
  const { ports } = await state.compose();
  const scope = state.scope();
  const open = state.current;
  state.current = null;
  state.lost = false;
  state.refreshError = null;
  if (open !== null) await revokeEgress(state, open, "failed");
  const saved = await state.options.state.load();
  const handle = open?.handle ?? saved?.handle;
  const { resumeRef: _released, ...points } = restorePoints(saved);
  state.dirty = false;
  // Forget the handle first; release only once the record no longer names it.
  if (!await state.commit({ stores: state.stores, outputs: state.outputs, ...points }, stateVersion(saved))) {
    if (open !== null) await state.releaseOwn(open.handle);
    return;
  }
  if (handle !== undefined) {
    await ports.sandbox.release({ scope, handle }).catch((error) => state.options.warn(`sandbox_release_failed runtime=${handle.runtimeId} error=${errorText(error)}`));
  }
}
