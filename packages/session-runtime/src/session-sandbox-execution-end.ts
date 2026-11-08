// The end of a Session execution (design §0.1 steps 7 and 9, §0.0 rule 16):
//   - endExecution: egress.revoke("completed") (a failure is only a
//     warning) → storage.sync("turn_end") → the handle is recorded → the
//     idle pause is armed. The sandbox keeps running; the next execution
//     attaches to it.
//   - failExecution: nothing is published; egress.revoke("failed") (a
//     warning), release, forget the handle; the next execution resumes from
//     the last recorded ResumeRef, else starts fresh.
// A lost fence (isCurrent false) exits without writing back or releasing.

import { armIdle, disarmIdle } from "./session-sandbox-idle-pause";
import { errorText, type LiveSessionSandbox } from "./session-sandbox-live";
import { revokeEgress, syncStorage } from "./session-sandbox-storage-egress";

export async function endExecution<R>(state: LiveSessionSandbox<R>): Promise<void> {
  await state.quiesce();
  if (!await state.isCurrent(state.execution())) {
    state.abandon();
    return;
  }
  if (state.current !== null) await revokeEgress(state, state.current, "completed");
  await syncStorage(state, "turn_end");
  if (state.current !== null) await state.record(state.current);
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
  if (handle !== undefined) {
    await ports.sandbox.release({ scope, handle }).catch((error) => state.options.warn(`sandbox_release_failed runtime=${handle.runtimeId} error=${errorText(error)}`));
  }
  await state.options.state.save({ stores: state.stores, outputs: state.outputs, ...(saved?.resumeRef === undefined ? {} : { resumeRef: saved.resumeRef }) });
}
