// Public API of the agent harness: the harness contract, the registry and
// built-in loops, the per-turn helpers both Session hosts (Cloudflare SessionDO
// and the Node control plane) compose, and the event-log → model history
// projection. Platform implementations stay in the hosts and arrive as Ports
// on HarnessContext.

export type {
  FileResolver,
  HarnessContext,
  HarnessDisposeReason,
  HarnessInterface,
  HarnessPendingInterruptContext,
  HarnessRuntime,
  HistoryStore,
  ProcessHandle,
  ResolvedFile,
  RunnerRelayAttachResult,
  RunnerRelayPort,
  RunnerRelaySocket,
  SandboxExecutor,
} from "./interface";
export {
  HarnessLease,
  getHarnessCatalog,
  registerHarness,
  resolveHarness,
  setDefaultHarness,
  type HarnessCatalog,
  type HarnessDescriptor,
  type HarnessExecutionPlacement,
  type HarnessFactory,
} from "./registry";
export { registerCoreHarnesses } from "./builtins";
export { DefaultHarness } from "./default-loop";
export { PiHarness } from "./pi-loop";
export { AcpSandboxHarness } from "./acp-sandbox-loop";
export { AcpProxyHarness } from "./acp-proxy-loop";
export { resolveRepositoryLocalPath } from "./acp-proxy-delivery";

export { readHarnessAgentModelSettings } from "./agent-model-settings";
export { createPiModelRuntime, toAiSdkLanguageModel, type PiModelConfig, type PiModelRuntime } from "./pi-provider";
export type { PiCompactionPolicy } from "./pi-compaction";
export {
  bindStoredModelCardCredentials,
  delegationCredentials,
  type ResolvedModelCardCredentials,
} from "./model-card-credentials";

export { composeSystemPrompt, platformGuidance } from "./platform-guidance";
export { resolveAppendablePrompts, listAppendablePrompts, type AppendablePrompt } from "./appendable-prompts";
export {
  getSkillFiles,
  getSkillFilesFromManagedSource,
  mountSkillFiles,
  registerSkill,
  resolveCustomSkillMounts,
  resolveCustomSkills,
  resolveSkills,
  type SkillMountDescriptor,
} from "./skills";
export {
  agentUsesAssemblySkillMount,
  resolveSkillAssemblyConfig,
  skillMountsShouldFetchBodies,
} from "./assembly/skill-config";
export { resolveRuntimeSkillFiles, resolveSubagentSkillReminders } from "./runtime-skills";
export { assertRuntimeAgentSnapshot, resolvePinnedSubagent, resolveThreadAgentSnapshot } from "./agent-snapshot";

export { ToolFailureError, buildTools, disposeTools } from "./tools";
export { resolveProxiedToolCall } from "./tool-proxy";

export { eventsToMessages, eventsToMessagesAsync } from "./history/events-to-messages";
export { INTERRUPTED_TOOL_RESULT_TEXT, interruptRequiresActionClosure } from "./history/interrupted-tool-calls";
export { stampEvent, type HistoryStampClock } from "./history/event-stamp";
export { InMemoryHistory } from "./history/in-memory-history";
