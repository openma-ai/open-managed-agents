export type {
  ProcessHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxCheckpointHandle,
  SandboxCheckpointKind,
  SandboxCheckpointScope,
  SandboxPort,
  SandboxPreparedBaseHandle,
  SandboxPreparedBasePort,
  SandboxExecutor,
  SandboxFactory,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxMemoryWorkspacePort,
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
  supportsPreparedBase,
  rejectPreparedBase,
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
} from "./environment-packages";
export type {
  EnvironmentPackages,
  EnvironmentPackagesOptions,
  EnvironmentPackagesPath,
  EnvironmentPackagesProgress,
  PackageSandbox,
} from "./environment-packages";
