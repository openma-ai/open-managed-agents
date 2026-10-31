import { snapshotSessionAgent } from "@open-managed-agents/managed-agents-application";
import type {
  AgentAcpConfig,
  SessionAgent,
  SessionAgentSourcePort,
  SessionThreadAgent,
  AgentCustomToolInputSchema,
  AgentMcpServer,
  AgentSkill,
  AgentTool,
  AgentToolConfig,
  AgentToolDefaultConfig,
  Environment,
  SessionBootstrapEvent,
  RuntimeProducedSessionEvent,
  SentSessionEvent,
  SessionEventView,
  SessionEventDeltaType,
  StartSessionExecution,
  StreamSessionEvent,
  ToolResultContentBlock,
  UserMessageContentBlock,
} from "@open-managed-agents/managed-agents-application";

export { AnthropicMessagesDreamCurator } from "./anthropic-messages-dream-curator";
export type {
  AnthropicMessagesDreamCuratorDependencies,
  DreamCuratorModelCredentials,
} from "./anthropic-messages-dream-curator";
export { ApplicationDreamMemoryWorkspace } from "./application-dream-memory-workspace";
export { ConfiguredModelCatalogSource } from "./configured-model-catalog";
export { ModelCardCatalogSource } from "./model-card-catalog";
export type {
  ModelCardCatalogReader,
  ModelCardCatalogRecord,
} from "./model-card-catalog";
export { configuredModelsModule } from "./configured-model-module";
export {
  IndeterminateCredentialValidationProbe,
  McpOAuthCredentialValidationProbe,
} from "./credential-validation-probe";
export type { McpOAuthCredentialValidationProbeOptions } from "./credential-validation-probe";
export { CronDeploymentSchedulePlanner } from "./deployment-schedule-planner";
export { DeduplicatingDreamCurator } from "./deduplicating-dream-curator";
export { TimerEnvironmentWorkAvailabilityWaiter } from "./environment-work-availability-waiter";
export * from "./environment-work-webhook-wakeup";
export { OpaqueEnvironmentWorkSessionCredentialIssuer } from "./environment-work-session-credential-issuer";
export * from "./environment-work-session-token";
export * from "./environment-work-runtime-ingress";
export {
  InProcessDreamExecutionScheduler,
  inProcessDreamExecutionSchedulerModule,
} from "./in-process-dream-execution-scheduler";
export type {
  InProcessDreamExecutionSchedulerDependencies,
  InProcessDreamExecutionSchedulerModuleOptions,
} from "./in-process-dream-execution-scheduler";
export {
  environmentExecutionAuthority,
  EnvironmentAwareSessionEventDispatchRouter,
  EnvironmentAwareSessionEventStreamRouter,
  EnvironmentAwareSessionLifecycleRouter,
} from "./session-lifecycle-router";
export type {
  EnvironmentAwareSessionEventStreamRouterDependencies,
  EnvironmentExecutionAuthority,
} from "./session-lifecycle-router";
export { LocalTunnelProvisioner } from "./local-tunnel-provisioner";
export { WebCryptoMemoryContentDescriptor } from "./memory-content-descriptor";
export * from "./managed-memory-snapshot";
export * from "./managed-session-memory-sync";
export { ZipSkillPackageCompiler } from "./skill-package-compiler";
export { WebCryptoTunnelCertificateAuthority } from "./webcrypto-tunnel-certificate-authority";
export { WebCryptoTunnelTokenManager } from "./webcrypto-tunnel-token-manager";

export const OFFICIAL_RUNTIME_EVENT_TYPES = new Set([
  "user.message",
  "user.interrupt",
  "user.tool_confirmation",
  "user.custom_tool_result",
  "user.define_outcome",
  "user.tool_result",
  "system.message",
  "agent.custom_tool_use",
  "agent.mcp_tool_result",
  "agent.mcp_tool_use",
  "agent.message",
  "agent.thinking",
  "agent.thread_context_compacted",
  "agent.thread_message_received",
  "agent.thread_message_sent",
  "agent.tool_result",
  "agent.tool_use",
  "session.deleted",
  "session.error",
  "session.warning",
  "session.status_idle",
  "session.status_rescheduled",
  "session.status_running",
  "session.status_terminated",
  "session.thread_created",
  "session.thread_status_idle",
  "session.thread_status_rescheduled",
  "session.thread_status_running",
  "session.thread_status_terminated",
  "session.updated",
  "session.usage",
  "span.model_request_start",
  "span.model_request_end",
  "span.outcome_evaluation_start",
  "span.outcome_evaluation_ongoing",
  "span.outcome_evaluation_end",
]);

function camelCaseKey(key: string): string {
  return key.replace(/_([a-z0-9])/gu, (_match, value: string) =>
    value.toUpperCase(),
  );
}

function camelCaseRuntimeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelCaseRuntimeValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      camelCaseKey(key),
      camelCaseRuntimeValue(item),
    ]),
  );
}

function snakeCaseKey(key: string): string {
  return key.replace(/[A-Z]/gu, (value) => `_${value.toLowerCase()}`);
}

function snakeCaseRuntimeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeCaseRuntimeValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      snakeCaseKey(key),
      snakeCaseRuntimeValue(item),
    ]),
  );
}

export function encodeRuntimeHistoryEvent(event: SessionEventView): object {
  return snakeCaseRuntimeValue(event) as object;
}

function normalizeRuntimeError(value: unknown): object {
  if (typeof value === "string") {
    return {
      type: "unknown_error",
      message: value,
      retryStatus: "terminal",
    };
  }
  const error = camelCaseRuntimeValue(value) as Record<string, unknown>;
  const retry = error.retryStatus;
  return {
    ...error,
    type: typeof error.type === "string" ? error.type : "unknown_error",
    message: typeof error.message === "string" ? error.message : "Runtime error",
    retryStatus:
      typeof retry === "string"
        ? retry
        : retry !== null && typeof retry === "object" &&
            typeof (retry as { type?: unknown }).type === "string"
          ? (retry as { type: string }).type
          : "terminal",
  };
}

function normalizeModelUsage(value: unknown): object {
  const normalized = camelCaseRuntimeValue(value);
  const usage =
    normalized !== null && typeof normalized === "object"
      ? normalized as Record<string, unknown>
      : {};
  return {
    cacheCreationInputTokens:
      typeof usage.cacheCreationInputTokens === "number"
        ? usage.cacheCreationInputTokens
        : 0,
    cacheReadInputTokens:
      typeof usage.cacheReadInputTokens === "number"
        ? usage.cacheReadInputTokens
        : 0,
    inputTokens: typeof usage.inputTokens === "number" ? usage.inputTokens : 0,
    outputTokens:
      typeof usage.outputTokens === "number" ? usage.outputTokens : 0,
    ...(usage.speed !== undefined && { speed: usage.speed }),
  };
}

export function decodeRuntimeEvent(
  value: unknown,
  deltaTypes: ReadonlySet<SessionEventDeltaType>,
): StreamSessionEvent[] {
  if (value === null || typeof value !== "object") return [];
  const raw = value as Record<string, unknown>;
  if (typeof raw.type !== "string") return [];
  if (
    raw.type === "agent.message_stream_start" ||
    raw.type === "agent.thinking_stream_start"
  ) {
    const type = raw.type.startsWith("agent.message")
      ? "agent.message"
      : "agent.thinking";
    const id = type === "agent.message" ? raw.message_id : raw.thinking_id;
    return deltaTypes.has(type) && typeof id === "string"
      ? [{ type: "event_start", event: { id, type } }]
      : [];
  }
  if (raw.type === "agent.message_chunk" || raw.type === "agent.thinking_chunk") {
    const type = raw.type === "agent.message_chunk"
      ? "agent.message"
      : "agent.thinking";
    const id = type === "agent.message" ? raw.message_id : raw.thinking_id;
    return deltaTypes.has(type) &&
      typeof id === "string" &&
      typeof raw.delta === "string"
      ? [
          {
            type: "event_delta",
            eventId: id,
            delta: {
              type: "content_delta",
              content: { type: "text", text: raw.delta },
              ...(typeof raw.index === "number" && { index: raw.index }),
            },
          },
        ]
      : [];
  }
  if (
    raw.type === "agent.message_stream_end" ||
    raw.type === "agent.thinking_stream_end"
  ) return [];
  if (
    raw.type === "system.user_message_cancelled" ||
    raw.type === "system.user_message_steered"
  ) {
    if (typeof raw.event_id !== "string" || raw.event_id.length === 0) return [];
    const kind = raw.type === "system.user_message_cancelled" ? "cancelled" : "steered";
    const at = kind === "cancelled" ? raw.cancelled_at : raw.steered_at;
    const occurredAt = typeof at === "number" && Number.isFinite(at)
      ? new Date(at).toISOString()
      : typeof at === "string" ? at : new Date().toISOString();
    return [{
      type: "oma.queue_lifecycle",
      kind,
      eventId: raw.event_id,
      ...(typeof raw.session_thread_id === "string" && {
        sessionThreadId: raw.session_thread_id,
      }),
      occurredAt,
    }];
  }
  if (!OFFICIAL_RUNTIME_EVENT_TYPES.has(raw.type)) return [];

  const decoded = camelCaseRuntimeValue(raw) as Record<string, unknown>;
  // event_start/event_delta use the runtime's stable block ids. Preserve the
  // same id on the eventual committed event so SDK consumers can atomically
  // replace their in-flight projection instead of guessing from arrival order.
  if (raw.type === "agent.message" && typeof raw.message_id === "string") {
    decoded.id = raw.message_id;
  }
  if (raw.type === "agent.thinking" && typeof raw.thinking_id === "string") {
    decoded.id = raw.thinking_id;
  }
  if (raw.type === "session.error") {
    decoded.error = normalizeRuntimeError(raw.error);
  }
  if (raw.type === "span.model_request_end") {
    decoded.modelUsage = normalizeModelUsage(raw.model_usage ?? raw.modelUsage);
    decoded.isError =
      typeof raw.is_error === "boolean"
        ? raw.is_error
        : typeof raw.isError === "boolean"
          ? raw.isError
          : null;
  }
  if (raw.type === "span.outcome_evaluation_end") {
    decoded.usage = normalizeModelUsage(raw.usage);
  }
  if (
    (raw.type === "agent.tool_result" || raw.type === "agent.mcp_tool_result")
    && typeof raw.content === "string"
  ) {
    // The legacy harness wire emits scalar tool output while the official
    // Managed Agents history contract requires an array of content blocks.
    // Normalize at the runtime boundary so every store/transport sees the
    // same canonical application shape.
    decoded.content = [{ type: "text", text: raw.content }];
  }
  return [decoded as unknown as StreamSessionEvent];
}

/**
 * Stateful decoder for a single live session stream.
 *
 * Some runtime transports can publish the terminal model span before the
 * persistence projection has attached `model_request_start_id`. The official
 * Managed Agents event requires that correlation id, so repair the live frame
 * from the preceding start event instead of weakening the public API schema.
 * The queue is scoped by session thread so concurrent sub-agent streams do not
 * steal each other's spans.
 */
export class RuntimeEventStreamDecoder {
  private readonly pendingModelStarts = new Map<string, string[]>();

  constructor(private readonly deltaTypes: ReadonlySet<SessionEventDeltaType>) {}

  decode(value: unknown): StreamSessionEvent[] {
    if (value === null || typeof value !== "object") {
      return decodeRuntimeEvent(value, this.deltaTypes);
    }
    const raw = value as Record<string, unknown>;
    const threadKey =
      typeof raw.session_thread_id === "string"
        ? raw.session_thread_id
        : typeof raw.sessionThreadId === "string"
          ? raw.sessionThreadId
          : "";
    let projected: unknown = raw;

    if (raw.type === "span.model_request_start" && typeof raw.id === "string") {
      const pending = this.pendingModelStarts.get(threadKey) ?? [];
      pending.push(raw.id);
      this.pendingModelStarts.set(threadKey, pending);
    } else if (raw.type === "span.model_request_end") {
      const explicitStartId =
        typeof raw.model_request_start_id === "string"
          ? raw.model_request_start_id
          : typeof raw.modelRequestStartId === "string"
            ? raw.modelRequestStartId
            : undefined;
      const pending = this.pendingModelStarts.get(threadKey) ?? [];
      const startId = explicitStartId ?? pending[0];
      if (startId !== undefined) {
        const matchedIndex = pending.indexOf(startId);
        if (matchedIndex >= 0) pending.splice(matchedIndex, 1);
        if (pending.length === 0) this.pendingModelStarts.delete(threadKey);
        else this.pendingModelStarts.set(threadKey, pending);
        if (explicitStartId === undefined) {
          projected = "modelRequestStartId" in raw
            ? { ...raw, modelRequestStartId: startId }
            : { ...raw, model_request_start_id: startId };
        }
      }
    }

    if (
      raw.type === "session.status_idle" ||
      raw.type === "session.status_terminated" ||
      raw.type === "session.deleted"
    ) {
      this.pendingModelStarts.clear();
    }
    return decodeRuntimeEvent(projected, this.deltaTypes);
  }
}

const ACCEPTED_INPUT_EVENT_TYPES = new Set([
  "user.message",
  "user.interrupt",
  "user.tool_confirmation",
  "user.custom_tool_result",
  "user.define_outcome",
  "user.tool_result",
  "system.message",
]);

export function decodeRuntimeProducedSessionEvent(
  value: unknown,
): RuntimeProducedSessionEvent | null {
  const [decoded] = decodeRuntimeEvent(value, new Set());
  if (
    decoded === undefined ||
    decoded.type === "event_start" ||
    decoded.type === "event_delta" ||
    ACCEPTED_INPUT_EVENT_TYPES.has(decoded.type) ||
    !("id" in decoded) ||
    typeof decoded.id !== "string" ||
    !("processedAt" in decoded) ||
    typeof decoded.processedAt !== "string"
  ) return null;
  return decoded as RuntimeProducedSessionEvent;
}

function runtimeSource(source: object): object {
  const value = source as Record<string, unknown>;
  return {
    ...value,
    ...(typeof value.mediaType === "string" && {
      media_type: value.mediaType,
    }),
    ...(typeof value.fileId === "string" && { file_id: value.fileId }),
    mediaType: undefined,
    fileId: undefined,
  };
}

function runtimeUserContent(block: UserMessageContentBlock): object {
  switch (block.type) {
    case "text":
    case "redacted":
      return { ...block };
    case "image":
      return { type: block.type, source: runtimeSource(block.source) };
    case "document":
      return {
        type: block.type,
        source: runtimeSource(block.source),
        ...(block.context !== undefined && { context: block.context }),
        ...(block.title !== undefined && { title: block.title }),
      };
  }
}

function runtimeToolContent(block: ToolResultContentBlock): object {
  if (block.type !== "search_result") return runtimeUserContent(block);
  return {
    type: block.type,
    citations: block.citations,
    content: block.content,
    source: block.source,
    title: block.title,
  };
}

function runtimeRubric(
  rubric: { type: "text"; content: string } | { type: "file"; fileId: string },
): object {
  return rubric.type === "file"
    ? { type: rubric.type, file_id: rubric.fileId }
    : { type: rubric.type, content: rubric.content };
}

export function encodeRuntimeSessionEvent(
  event: SessionBootstrapEvent | SentSessionEvent,
): object {
  const base = "id" in event
    ? {
        id: event.id,
        ...(event.processedAt !== undefined && {
          processed_at: event.processedAt,
        }),
      }
    : {};
  switch (event.type) {
    case "user.message":
      return {
        ...base,
        type: event.type,
        content: event.content.map(runtimeUserContent),
      };
    case "user.interrupt":
      return {
        ...base,
        type: event.type,
        ...(event.sessionThreadId !== undefined && {
          session_thread_id: event.sessionThreadId,
        }),
      };
    case "user.tool_confirmation":
      return {
        ...base,
        type: event.type,
        result: event.result,
        tool_use_id: event.toolUseId,
        ...(event.denyMessage !== undefined && {
          deny_message: event.denyMessage,
        }),
        ...(event.sessionThreadId !== undefined && {
          session_thread_id: event.sessionThreadId,
        }),
      };
    case "user.custom_tool_result":
      return {
        ...base,
        type: event.type,
        custom_tool_use_id: event.customToolUseId,
        ...(event.content !== undefined && {
          content: event.content.map(runtimeToolContent),
        }),
        ...(event.isError !== undefined && { is_error: event.isError }),
        ...(event.sessionThreadId !== undefined && {
          session_thread_id: event.sessionThreadId,
        }),
      };
    case "user.define_outcome":
      return {
        ...base,
        type: event.type,
        description: event.description,
        rubric: runtimeRubric(event.rubric),
        ...(event.maxIterations !== undefined && {
          max_iterations: event.maxIterations,
        }),
        ...("outcomeId" in event && { outcome_id: event.outcomeId }),
      };
    case "user.tool_result":
      return {
        ...base,
        type: event.type,
        tool_use_id: event.toolUseId,
        ...(event.content !== undefined && {
          content: event.content.map(runtimeToolContent),
        }),
        ...(event.isError !== undefined && { is_error: event.isError }),
        ...(event.sessionThreadId !== undefined && {
          session_thread_id: event.sessionThreadId,
        }),
      };
    case "system.message":
      return { ...base, type: event.type, content: event.content };
  }
}

function runtimeEnvironmentConfig(environment: Environment): object {
  if (environment.config.type === "self_hosted") {
    return { type: "self_hosted" };
  }
  const networking = environment.config.networking;
  return {
    type: "cloud",
    packages: environment.config.packages,
    networking:
      networking.type === "unrestricted"
        ? { type: "unrestricted" }
        : {
            type: "limited",
            allowed_hosts: networking.allowedHosts,
            allow_mcp_servers: networking.allowMcpServers,
            allow_package_managers: networking.allowPackageManagers,
          },
  };
}

interface RuntimePermissionPolicy {
  type: "always_allow" | "always_ask";
}

interface RuntimeToolDefaultConfig {
  enabled: boolean;
  permission_policy: RuntimePermissionPolicy;
}

interface RuntimeToolUserLocation {
  type: "approximate";
  city?: string | null;
  country?: string | null;
  region?: string | null;
  timezone?: string | null;
}

interface RuntimeAgentToolConfig {
  enabled: boolean;
  name: AgentToolConfig["name"];
  permission_policy: RuntimePermissionPolicy;
  type: AgentToolConfig["type"];
  allowed_domains?: string[];
  blocked_domains?: string[];
  max_content_tokens?: number | null;
  user_location?: RuntimeToolUserLocation | null;
}

type RuntimeAgentTool =
  | {
      type: "agent_toolset_20260401";
      configs: RuntimeAgentToolConfig[];
      default_config: RuntimeToolDefaultConfig;
    }
  | {
      type: "mcp_toolset";
      mcp_server_name: string;
      configs: Array<{
        name: string;
        enabled: boolean;
        permission_policy: RuntimePermissionPolicy;
      }>;
      default_config: RuntimeToolDefaultConfig;
    }
  | {
      type: "custom";
      name: string;
      description: string;
      input_schema: AgentCustomToolInputSchema;
    };

type RuntimeModel = {
  id: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  inference_geo?: string;
  provider_options?: Record<string, unknown>;
  speed?: "standard" | "fast";
};

/** The Agent configuration a Session's runtime executes. */
export interface RuntimeAgentSnapshot {
  id: string;
  name: string;
  description: string | null;
  model: RuntimeModel;
  aux_model?: RuntimeModel & { max_tokens?: number };
  appendable_prompts?: string[];
  harness?: string;
  acp?: {
    agent: { id?: string; command?: string; registry?: string; args?: string[]; env?: Record<string, string | undefined>; cwd?: string };
    restart?: { mode: "never" | "on-crash" | "always"; max_restarts?: number; window_ms?: number };
    idle_timeout_ms?: number;
    per_turn_timeout_ms?: number;
  };
  runtime_binding?: { runtime_id: string; acp_agent_id: string; local_skill_blocklist?: string[] };
  context_management?: unknown;
  model_settings?: unknown;
  compaction_wire_format?: string;
  enable_general_subagent?: boolean;
  metadata?: Record<string, string>;
  system: string;
  tools: RuntimeAgentTool[];
  mcp_servers: AgentMcpServer[];
  skills: Array<{ type: AgentSkill["type"]; skill_id: string; version: string }>;
  version: number;
  created_at: string;
  updated_at: string;
  multiagent?: {
    type: "multiagent_20261001";
    advisor: { type: "disabled" };
    subagents:
      | { type: "disabled" }
      | {
          type: "enabled";
          inline_agents: { type: "enabled" } | { type: "disabled" };
          predefined_agents: Array<RuntimeAgentSnapshot & { type: "agent" }>;
        };
    workflows: { type: "disabled" };
  };
}

export interface RuntimeSessionStart {
  agent_id: string;
  environment_id: string;
  title: string;
  session_id: string;
  tenant_id: string;
  vault_ids: string[];
  agent_snapshot: RuntimeAgentSnapshot;
  environment_snapshot: object;
  init_events: object[];
}

function runtimePermissionPolicy(
  policy: AgentToolDefaultConfig["permissionPolicy"],
): RuntimePermissionPolicy {
  return { type: policy.type };
}

function runtimeDefaultToolConfig(
  config: AgentToolDefaultConfig,
): RuntimeToolDefaultConfig {
  return {
    enabled: config.enabled,
    permission_policy: runtimePermissionPolicy(config.permissionPolicy),
  };
}

function runtimeToolConfig(config: AgentToolConfig): RuntimeAgentToolConfig {
  const common: RuntimeAgentToolConfig = {
    enabled: config.enabled,
    name: config.name,
    permission_policy: runtimePermissionPolicy(config.permissionPolicy),
    type: config.type,
  };
  switch (config.type) {
    case "web_fetch":
      return {
        ...common,
        ...(config.allowedDomains !== undefined && {
          allowed_domains: config.allowedDomains,
        }),
        ...(config.blockedDomains !== undefined && {
          blocked_domains: config.blockedDomains,
        }),
        ...(config.maxContentTokens !== undefined && {
          max_content_tokens: config.maxContentTokens,
        }),
      };
    case "web_search":
      return {
        ...common,
        ...(config.allowedDomains !== undefined && {
          allowed_domains: config.allowedDomains,
        }),
        ...(config.blockedDomains !== undefined && {
          blocked_domains: config.blockedDomains,
        }),
        ...(config.userLocation !== undefined && {
          user_location:
            config.userLocation === null
              ? null
              : {
                  type: config.userLocation.type,
                  ...(config.userLocation.city !== undefined && {
                    city: config.userLocation.city,
                  }),
                  ...(config.userLocation.country !== undefined && {
                    country: config.userLocation.country,
                  }),
                  ...(config.userLocation.region !== undefined && {
                    region: config.userLocation.region,
                  }),
                  ...(config.userLocation.timezone !== undefined && {
                    timezone: config.userLocation.timezone,
                  }),
                },
        }),
      };
    default:
      return common;
  }
}

function runtimeAgentTool(tool: AgentTool): RuntimeAgentTool {
  switch (tool.type) {
    case "agent_toolset_20260401":
      return {
        type: tool.type,
        configs: tool.configs.map(runtimeToolConfig),
        default_config: runtimeDefaultToolConfig(tool.defaultConfig),
      };
    case "mcp_toolset":
      return {
        type: tool.type,
        mcp_server_name: tool.mcpServerName,
        configs: tool.configs.map((config) => ({
          name: config.name,
          enabled: config.enabled,
          permission_policy: runtimePermissionPolicy(config.permissionPolicy),
        })),
        default_config: runtimeDefaultToolConfig(tool.defaultConfig),
      };
    case "custom":
      return {
        type: tool.type,
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      };
  }
}

/**
 * Encode a Session's Agent snapshot in the runtime's wire shape. The
 * timestamps are the Session's, so a resumed Session sees the same snapshot.
 */
export function encodeRuntimeAgentSnapshot(
  agent: SessionAgent | Extract<SessionThreadAgent, { type: "agent" }>,
  times: { createdAt: string; updatedAt: string },
): RuntimeAgentSnapshot {
  const multiagent = "multiagent" in agent ? agent.multiagent : null;
  const openma = agent.openma;
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    model: runtimeModel(agent.model),
    ...(openma?.auxiliaryModel !== undefined && { aux_model: {
      ...runtimeModel(openma.auxiliaryModel),
      ...(openma.auxiliaryModel.maxTokens !== undefined && { max_tokens: openma.auxiliaryModel.maxTokens }),
    } }),
    ...(openma?.appendablePrompts !== undefined && { appendable_prompts: structuredClone(openma.appendablePrompts) }),
    ...(openma?.harness !== undefined && { harness: openma.harness }),
    ...(openma?.acp !== undefined && { acp: runtimeAcp(openma.acp) }),
    ...(openma?.runtimeBinding !== undefined && { runtime_binding: {
      runtime_id: openma.runtimeBinding.runtimeId,
      acp_agent_id: openma.runtimeBinding.acpAgentId,
      ...(openma.runtimeBinding.localSkillBlocklist !== undefined && {
        local_skill_blocklist: [...openma.runtimeBinding.localSkillBlocklist],
      }),
    } }),
    ...(openma?.contextManagement !== undefined && { context_management: structuredClone(openma.contextManagement) }),
    ...(openma?.openaiModelSettings !== undefined && { model_settings: structuredClone(openma.openaiModelSettings) }),
    ...(openma?.compactionWireFormat !== undefined && { compaction_wire_format: openma.compactionWireFormat }),
    ...(openma?.enableGeneralSubagent !== undefined && { enable_general_subagent: openma.enableGeneralSubagent }),
    ...(agent.metadata !== undefined && { metadata: { ...agent.metadata } }),
    system: agent.system ?? "",
    tools: agent.tools.map(runtimeAgentTool),
    mcp_servers: agent.mcpServers.map((server) => ({ ...server })),
    skills: agent.skills.map((skill) => ({
      type: skill.type,
      skill_id: skill.skillId,
      version: skill.version,
    })),
    version: agent.version,
    created_at: times.createdAt,
    updated_at: times.updatedAt,
    ...(multiagent !== null && {
      multiagent: {
        type: multiagent.type,
        advisor: { type: "disabled" },
        subagents:
          multiagent.subagents.type === "disabled"
            ? { type: "disabled" }
            : {
                type: "enabled",
                inline_agents: multiagent.subagents.inlineAgents,
                predefined_agents: multiagent.subagents.predefinedAgents
                  .filter((member): member is Extract<SessionThreadAgent, { type: "agent" }> => member.type === "agent")
                  .map((member) => ({ type: "agent" as const, ...encodeRuntimeAgentSnapshot(member, times) })),
              },
        workflows: { type: "disabled" },
      },
    }),
  };
}

function runtimeAcp(acp: AgentAcpConfig): NonNullable<RuntimeAgentSnapshot["acp"]> {
  return {
    agent: structuredClone(acp.agent),
    ...(acp.restart !== undefined && { restart: {
      mode: acp.restart.mode,
      ...(acp.restart.maxRestarts !== undefined && { max_restarts: acp.restart.maxRestarts }),
      ...(acp.restart.windowMs !== undefined && { window_ms: acp.restart.windowMs }),
    } }),
    ...(acp.idleTimeoutMs !== undefined && { idle_timeout_ms: acp.idleTimeoutMs }),
    ...(acp.perTurnTimeoutMs !== undefined && { per_turn_timeout_ms: acp.perTurnTimeoutMs }),
  };
}

/**
 * Freeze the current Agent, with its pinned subagents, for a Session started
 * outside the Managed Agents application. Null when the Agent does not exist
 * or is archived; throws when a pinned subagent cannot be resolved.
 */
export async function loadRuntimeAgentSnapshot(
  store: SessionAgentSourcePort,
  workspaceId: string,
  agentId: string,
): Promise<RuntimeAgentSnapshot | null> {
  const agent = await store.findCurrent({ workspaceId, agentId });
  if (agent === null || agent.archivedAt !== null) return null;
  const snapshot = await snapshotSessionAgent(agent, store, workspaceId);
  if (snapshot === null) throw new Error(`Agent ${agentId} has an unavailable pinned subagent or unsupported multiagent configuration`);
  return encodeRuntimeAgentSnapshot(snapshot, agent);
}

function runtimeModel(model: SessionAgent["model"]): RuntimeModel {
  return {
    id: model.id,
    ...(model.effort !== undefined && { effort: model.effort }),
    ...(model.inferenceGeo !== undefined && { inference_geo: model.inferenceGeo }),
    ...(model.providerOptions !== undefined && { provider_options: structuredClone(model.providerOptions) }),
    ...(model.speed !== undefined && { speed: model.speed }),
  };
}

export function encodeRuntimeSessionStart(
  input: StartSessionExecution,
): RuntimeSessionStart {
  const { session, environment } = input;
  return {
    agent_id: session.agent.id,
    environment_id: session.environmentId,
    title: session.title ?? "",
    session_id: session.id,
    tenant_id: input.workspaceId,
    vault_ids: session.vaultIds,
    agent_snapshot: encodeRuntimeAgentSnapshot(input.session.agent, input.session),
    environment_snapshot: {
      type: "environment",
      id: environment.id,
      name: environment.name,
      ...(environment.description !== null && {
        description: environment.description,
      }),
      config: runtimeEnvironmentConfig(environment),
      metadata: environment.metadata,
      created_at: environment.createdAt,
      updated_at: environment.updatedAt,
      ...(environment.archivedAt !== null && {
        archived_at: environment.archivedAt,
      }),
    },
    init_events: input.initialEvents.map(encodeRuntimeSessionEvent),
  };
}
