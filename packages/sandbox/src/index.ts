export type {
  ProcessHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxCheckpointHandle,
  SandboxCheckpointKind,
  SandboxCheckpointScope,
  SandboxPort,
  SandboxExecutor,
  SandboxFactory,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxProviderPort,
  SandboxRuntimeCapabilities,
  SandboxRuntimeHandle,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
} from "./ports";
export { supportsDuplexProcess, supportsSandboxRuntime } from "./ports";
export {
  runWithSandboxLease,
  SandboxLeaseLostError,
  type RunWithSandboxLeaseOptions,
  type SandboxLeaseScheduler,
} from "./lease";

export {
  DefaultSandboxOrchestrator,
  type SandboxOrchestrator,
  type SandboxCapabilities,
  type ProvisionInput,
  type OrchestratorMemoryMount,
  type OrchestratorBackupHandle,
  type WorkspaceBackupService,
  type DefaultSandboxOrchestratorDeps,
} from "./orchestrator";
