// Public surface of @open-managed-agents/session-runtime.
//
// Phase 2 of the unified-runtime refactor: SessionStateMachine + the
// shared RuntimeAdapterImpl land here so apps/main-node (Node) can
// adopt them. Phase 3 swaps apps/agent's SessionDO to use the same
// SessionStateMachine.
//
// See nifty-prancing-flamingo.md plan for the full architecture.

export {
  recoverInterruptedState,
  type RecoverInterruptedStateOptions,
  type RecoveryReport,
  type RecoveryWarning,
} from "./recovery";

export type { RuntimeAdapter, TurnId, OrphanTurn } from "./ports";
export { RuntimeAdapterImpl, type RuntimeAdapterOptions } from "./adapter";
export {
  SessionExecutionHost,
  type SessionExecutionHostDependencies,
  type SessionExecutionHostResult,
  type SessionExecutionHostTimers,
  type SessionExecutionRun,
} from "./execution-host";
export {
  SessionStateMachine,
  type SessionMachineDeps,
  type HarnessRunFn,
} from "./machine";

export type {
  SessionRouter,
  SessionInitParams,
  SessionEventsQuery,
  SessionEventsPage,
  SessionFullStatus,
  SessionExecResult,
  SessionAppendResult,
  SessionStreamFrame,
  SessionStreamHandle,
  FileIdResolver,
} from "./router";

export { SessionSandboxRuntime, type SessionSandboxMode } from "./session-sandbox";
export { PortsSessionSandbox } from "./ports-session-sandbox";
export type {
  PortsSessionSandboxOptions,
  SessionSandboxExecution,
  SessionSandboxExecutor,
  SessionSandboxIdleTimer,
  SessionSandboxState,
} from "./session-sandbox-options";
export { SessionSandboxFenceLostError, executionOfFence, runtimeFenceOf } from "./session-sandbox-fence";
export { STORAGE_SYNC_INTERVAL_MS } from "./session-sandbox-renewal";
export { LIFETIME_REFRESH_MARGIN_MS, MAX_TOOL_CALL_MS } from "./session-sandbox-lifetime";
export {
  runAgentTurn,
  TurnAborted,
  type RunAgentTurnOptions,
  type TurnContext,
  type TurnError,
  type TurnRuntimeAgent,
} from "./turn-lifetime";
export {
  clearTurnRecoveryCount,
  recoverAgentTurn,
  type PartialStream,
  type RecoverAgentTurnOptions,
  type RecoveryContext,
  type RecoveryDecision,
} from "./turn-recovery";
export { abortableDelay, abortedError, cancellationError, isAbortError, linkAbort, untilAborted } from "./turn-abort";
export {
  isTurnCancellationError,
  planTurnFailure,
  reportTurnFailure,
  type PlanTurnFailureInput,
  type TurnFailureClass,
  type TurnFailureEventsPort,
  type TurnFailurePlan,
} from "./turn-failure";
export { openTurnMarker, type TurnMarker, type TurnMarkerHooks } from "./turn-marker";
