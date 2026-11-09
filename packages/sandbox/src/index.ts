export { supportsCredentialEgress, DEFAULT_WORKSPACE_ROOT, PLATFORM_ROOT, workspaceRootFromProbe, workspaceRootOf } from "./ports";
export type { SandboxCredentialEgressBinding, SandboxCredentialEgressPort } from "./ports";
export type {
  ProcessHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxCheckpointHandle,
  SandboxCheckpointKind,
  SandboxCheckpointScope,
  SandboxPort,
  SandboxFactoryCapabilities,
  SandboxExecutor,
  SandboxFactory,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxProviderPort,
  SandboxRuntimeCapabilities,
  SandboxRuntimeHandle,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
  SandboxWorkspaceBackupPort,
  SandboxManagedWorkspaceLifecyclePort,
  SandboxSessionOutputMountPort,
} from "./ports";
export {
  supportsDuplexProcess,
  supportsManagedWorkspaceLifecycle,
  withSandboxFactoryCapabilities,
  supportsSandboxRuntime,
  supportsSessionOutputMount,
  supportsWorkspaceBackup,
  readS3MemoryBucket,
} from "./ports";
export {
  runWithSandboxLease,
  SandboxLeaseLostError,
  type RunWithSandboxLeaseOptions,
  type SandboxLeaseScheduler,
} from "./lease";

export {
  probeSandboxLiveness,
  startSandboxHeartbeat,
  withSandboxRecovery,
  SandboxRecoveryFailedError,
  SandboxReplacedError,
  type SandboxHeartbeatOptions,
  type SandboxLiveness,
  type SandboxRecovery,
  type SandboxRecoveryOptions,
} from "./recovery";

export {
  withSandboxExecutionGuard,
  SandboxExecutionFencedError,
  type SandboxExecutionGuard,
} from "./execution-guard";

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

export { createNoEnvironmentSandbox, isNoEnvironmentSandbox } from "./no-environment";

// Sandbox SDK v2 domain contract: the three Ports the core calls.
export { RetryableSandboxError, SandboxGoneError } from "./sandbox-ports";
export type {
  Acquired,
  EgressPolicy,
  EnvironmentSnapshotRef,
  HostPattern,
  MemoryStoreBinding,
  ResumeRef,
  SandboxEgressPort,
  SandboxHandle,
  SandboxLifecyclePort,
  SandboxPlan,
  SandboxPorts,
  SandboxStoragePort,
  Substitution,
} from "./sandbox-ports";
export {
  createSandboxImageCatalog,
  EMPTY_SANDBOX_IMAGE_CATALOG,
  parseSandboxImageCatalog,
  rejectSandboxImageSelection,
  resolveSandboxImage,
  SandboxImageCatalogError,
  SandboxImageUnavailableError,
} from "./sandbox-images";
export type {
  ResolvedSandboxImage,
  SandboxImageCatalog,
  SandboxImageCatalogEntry,
  SandboxImageCatalogListing,
} from "./sandbox-images";
export {
  buildAptScript,
  buildFullSetupScript,
  ENVIRONMENT_PACKAGE_PATHS,
  ensureEnvironmentPackages,
  hasEnvironmentPackages,
  parseExecResult,
  UNKNOWN_EXIT_CODE,
} from "./environment-packages";
export type {
  EnvironmentPackages,
  EnvironmentPackagesOptions,
  EnvironmentPackagesPath,
  EnvironmentPackagesProgress,
  PackageSandbox,
} from "./environment-packages";
