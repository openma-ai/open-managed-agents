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
  type SessionExecutionRunResult,
  type SessionLaneDrain,
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

export {
  mountSessionResources,
  type SessionResourceMountPorts,
  type SessionResourceSandbox,
} from "./session-resource-mount";
export {
  memoryStoreMountTarget,
  planSessionResourceMounts,
  type RepositoryMount,
  type SessionResourceMount,
  type SessionResourceRecord,
} from "./session-resource-records";
export {
  assertCommandSucceeded,
  commandScopedRepositoryAccess,
  shellQuote,
  type RepositoryAccessPort,
} from "./session-resource-repository";

export { SessionSandboxRuntime, type SessionSandboxMode } from "./session-sandbox";
export { PortsSessionSandbox } from "./ports-session-sandbox";
export { sessionSandboxWarningEvent } from "./session-warning";
export type {
  PortsSessionSandboxOptions,
  SessionSandboxExecution,
  SessionSandboxExecutor,
  SessionSandboxIdleTimer,
} from "./session-sandbox-options";
export {
  initialSandboxState,
  recordedHandle,
  SANDBOX_TRANSITIONS,
  SessionSandboxTransitionError,
  stateVersion,
  transition,
  type LatestSnapshot,
  type SandboxAction,
  type SandboxActionType,
  type SandboxPhase,
  type SandboxPhaseName,
  type SessionSandboxState,
  type SnapshotRef,
} from "./session-sandbox-state";
export { SessionSandboxFenceLostError, executionOfFence, runtimeFenceOf } from "./session-sandbox-fence";
export { SessionSandboxStateConflictError } from "./session-sandbox-live";
export { SandboxRestoreError } from "./session-sandbox-open";
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
export { finishTurn, type TurnEndPort, type TurnStop } from "./turn-end";
export {
  classifyTurnFailure,
  isTurnCancellationError,
  planTurnFailure,
  reportTurnFailure,
  settleTurnFailure,
  type PlanTurnFailureInput,
  type TurnFailureClass,
  type TurnFailureEventsPort,
  type TurnFailurePlan,
} from "./turn-failure";
export { openTurnMarker, type TurnMarker, type TurnMarkerHooks } from "./turn-marker";
export {
  interruptTurn,
  type InterruptibleTurn,
  type LaneStatus,
  type TurnInterruptPort,
  type TurnInterruptResult,
} from "./turn-interrupt";
export {
  ORPHAN_SANDBOX_MIN_AGE_MS,
  reclaimOrphanSandboxes,
  type OrphanSandboxSession,
  type ReclaimOrphanSandboxesInput,
  type ReclaimOrphanSandboxesResult,
} from "./session-sandbox-orphans";
export {
  SessionTemplateCache,
  TEMPLATE_UNUSED_TTL_MS,
  TEMPLATE_USED_TTL_MS,
  isTemplateGone,
  templateExpired,
  templateExpiry,
  type SessionTemplateCacheOptions,
  type TemplateBuilder,
  type TemplateEntry,
  type TemplateExpiry,
  type TemplateHandle,
  type TemplateLogger,
  type TemplateStore,
} from "./session-sandbox-template-cache";
export { finalizeStaleTurns, type StaleToolUse, type StaleTurnFinalizerPort } from "./finalize-stale-turns";
