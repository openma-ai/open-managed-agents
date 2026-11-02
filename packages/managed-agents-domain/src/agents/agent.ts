import type {
  AgentMcpServer,
  AgentMultiagent,
  AgentSkill,
  AgentTool,
} from "./definition";
import type { JsonObject } from "../json";

export type AgentEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentSpeed = "standard" | "fast";

export interface AgentModel {
  id: string;
  effort?: AgentEffortLevel;
  inferenceGeo?: string;
  /** Provider-namespaced, JSON-compatible inference options. */
  providerOptions?: JsonObject;
  speed?: AgentSpeed;
  /** OMA extension: per-turn output token ceiling (catalog default when unset). */
  maxTokens?: number;
}

/** Mirrors Anthropic Messages `context_management.edits` compaction shape. */
export interface AgentContextManagementEdit {
  type: "compact" | "compact_20260112";
  trigger?: { type: "input_tokens"; value: number };
  instructions?: string;
  pause_after_compaction?: boolean;
}

export interface AgentContextManagement {
  edits: AgentContextManagementEdit[];
}

/** OpenAI Agents SDK `model_settings` compaction shape. */
export interface AgentOpenAiModelSettings {
  max_tokens?: number;
  context_management?: Array<{
    type: "compaction";
    compact_threshold: number;
  }>;
}

export type AgentCompactionWireFormat =
  | "anthropic_context_management"
  | "openai_model_settings";

export interface AgentAcpProcess {
  id?: string;
  /** Explicit process; exactly one of `command` or `registry` is set. */
  command?: string;
  /** Pinned ACP registry reference such as `claude-acp@0.94.0`. */
  registry?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface AgentAcpRestartPolicy {
  mode: "never" | "on-crash" | "always";
  maxRestarts?: number;
  windowMs?: number;
}

export interface AgentAcpConfig {
  agent: AgentAcpProcess;
  restart?: AgentAcpRestartPolicy;
  idleTimeoutMs?: number;
  perTurnTimeoutMs?: number;
}

export interface AgentRuntimeBinding {
  runtimeId: string;
  acpAgentId: string;
  localSkillBlocklist?: string[];
}

/**
 * OpenMA additions to the Anthropic Managed Agents resource. These values are
 * versioned with the Agent so a Session can pin one atomic configuration.
 */
export interface AgentOpenMaExtensions {
  auxiliaryModel?: AgentModel;
  appendablePrompts?: string[];
  contextManagement?: AgentContextManagement;
  openaiModelSettings?: AgentOpenAiModelSettings;
  compactionWireFormat?: AgentCompactionWireFormat;
  harness?: string;
  acp?: AgentAcpConfig;
  runtimeBinding?: AgentRuntimeBinding;
  enableGeneralSubagent?: boolean;
  /**
   * Versioned adapter-owned data that has no public Managed Agents field.
   * API mappers intentionally do not expose this internal persistence slot.
   */
  compatibility?: JsonObject;
}

export interface Agent {
  id: string;
  archivedAt: string | null;
  createdAt: string;
  description: string | null;
  mcpServers: AgentMcpServer[];
  metadata: Record<string, string>;
  model: AgentModel;
  multiagent: AgentMultiagent | null;
  name: string;
  openma?: AgentOpenMaExtensions;
  skills: AgentSkill[];
  system: string | null;
  tools: AgentTool[];
  updatedAt: string;
  version: number;
}
