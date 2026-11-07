// Public surface — runtime-agnostic eval runner (Node + Cloudflare).
export { tickEvalRuns, loadRun, saveRun, stopRunTrials, type EvalRunnerContext, type EvalRunnerServices } from "./tick";
export { advanceHarborRun, summariseHarborTask, sessionSandbox, DEFAULT_HARBOR_CONCURRENCY, DEFAULT_EVAL_CONCURRENCY } from "./harbor";
export {
  createManagedEvalRuntime,
  EvalRuntimeError,
  type EvalSessionRuntime,
  type EvalExecResult,
  type EvalSessionSettlement,
  type ManagedEvalRuntimeDependencies,
} from "./runtime";
export { parseGitUrl, resolveGitRef, listGitRefs, parseRefAdvertisement, gitEntries, type GitRepo, type GitRefList } from "./git-source";
export {
  EvalBenchmarkStore,
  EvalBenchmarkError,
  collectHarborBundles,
  benchmarkToApi,
  caseToApi,
  caseDetail,
  runnableCase,
  parseMessagesCase,
  messagesCaseSpec,
  listBuiltinBenchmarks,
  BUILTIN_EVAL_BENCHMARKS,
  DEFAULT_HARBOR_REGISTRY_URL,
  CASE_NAME,
  REWARD_TYPES,
  type StoredEvalBenchmark,
  type StoredEvalCase,
  type StoredHarborCase,
  type StoredMessagesCase,
  type StoredRevision,
  type CollectedHarborSource,
  type HarborImportDeps,
  type ImageAliasResolver,
} from "./benchmarks";
export type { EvalRunRecord, EvalTaskSpec, EvalTaskResult, EvalTrialResult, EvalRunStatus, HarborTaskRuntimeConfig } from "./types";
export { rowToRecord, extractResults, recordToApi, kvKey, isTerminal } from "./types";
