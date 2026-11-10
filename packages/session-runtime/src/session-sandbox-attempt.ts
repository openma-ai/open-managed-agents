import { SessionSandboxFenceLostError } from "./session-sandbox-fence";
import { SessionSandboxStateConflictError, type LiveSessionSandbox } from "./session-sandbox-live";
import { recordedHandle, transition, type SessionSandboxState } from "./session-sandbox-state";

export async function isolateSandboxAttempt<R>(state: LiveSessionSandbox<R>, record: SessionSandboxState): Promise<SessionSandboxState> {
  if (!state.options.isolateExecutionAttempts?.()) return record;
  const execution=state.execution();
  if (!execution) return record;
  if (!await state.isCurrent(execution)) throw new SessionSandboxFenceLostError("Current execution required before sandbox attach");
  const binding={executionId:execution.executionId,attemptId:execution.attemptId,ownerId:execution.ownerId,generation:execution.generation};
  const handle=recordedHandle(record);
  if (state.current && (state.current.handle.provider!==handle?.provider || state.current.handle.runtimeId!==handle.runtimeId)) state.current=null;
  if (handle && JSON.stringify(record.attemptBinding)!==JSON.stringify(binding)) {
    state.current=null;
    const next=record.pristine ? {...record,version:record.version+1,attemptBinding:binding,pristine:false}
      : transition(record,{type:"lose",retire:handle,requireSnapshot:true});
    // Same record/version arbitrates claim, retirement, publication and snapshot.
    if (!await state.isCurrent(execution)) throw new SessionSandboxFenceLostError("Execution lost before physical retirement CAS");
    if (!await state.options.state.save(next,record.version)) throw new SessionSandboxStateConflictError("Sandbox attempt retirement CAS lost; no physical cleanup authorized");
    record=next;
  }
  if (record.requireSnapshot) {
    state.current=null;
    record=await state.retryReleases(record,execution);
    if (!await state.isCurrent(execution)) throw new SessionSandboxFenceLostError("Execution lost during physical retirement");
    if (record.retiredHandles?.some(entry=>!entry.released)) throw new Error("Sandbox physical retirement is unconfirmed; reuse blocked");
    if (record.latestSnapshot.status!=="taken" && await state.options.resumeRef()===null) throw new Error("Sandbox attempt changed without a recoverable snapshot; recovery blocked");
  }
  return record;
}
