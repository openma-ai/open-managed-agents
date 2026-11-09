/** Event-sourced harness context. The event log, not sandbox files, owns existence. */
export type HarnessContextState =
  | { state: "none" }
  | { state: "started"; acp_session_id: string; checkpoint_fingerprint: string; configuration_sha256: string }
  | { state: "native"; acp_session_id: string; checkpoint_fingerprint: string }
  | { state: "rebuilt"; from: "canonical_history"; reason: string; acp_session_id: string; checkpoint_fingerprint: string };

export type HarnessContextAction =
  | { type: "record_native"; id: string; fingerprint: string }
  | { type: "rebuild"; reason: string; id: string; fingerprint: string };

export function transitionHarnessContext(_state: HarnessContextState, action: HarnessContextAction): HarnessContextState {
  if (!action.id || !action.fingerprint) throw new Error("Harness context requires a native id and checkpoint fingerprint");
  const native = { acp_session_id: action.id, checkpoint_fingerprint: action.fingerprint };
  return action.type === "record_native" ? { state: "native", ...native }
    : { state: "rebuilt", from: "canonical_history", reason: action.reason, ...native };
}

export function harnessContextFromEvents(events: readonly { type: string; source?: string; details?: Record<string, unknown> }[]): HarnessContextState {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "session.warning" || event.source !== "oma.acp_context") continue;
    const d = event.details;
    if (!d || typeof d.acp_session_id !== "string" || !d.acp_session_id || typeof d.checkpoint_fingerprint !== "string") continue;
    if (d.state === "started" && typeof d.configuration_sha256 === "string") return {state:"started", acp_session_id:d.acp_session_id, checkpoint_fingerprint:d.checkpoint_fingerprint, configuration_sha256:d.configuration_sha256};
    if (d.state === "native") return { state: "native", acp_session_id: d.acp_session_id, checkpoint_fingerprint: d.checkpoint_fingerprint };
    if (d.state === "rebuilt" && d.from === "canonical_history" && typeof d.reason === "string") return { state: "rebuilt", from: "canonical_history", reason: d.reason, acp_session_id: d.acp_session_id, checkpoint_fingerprint: d.checkpoint_fingerprint };
  }
  return { state: "none" };
}
