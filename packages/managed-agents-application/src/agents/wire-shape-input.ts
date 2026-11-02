import type { AgentEffortLevel, AgentSpeed } from "../domain/agent";
import type { JsonObject } from "../domain/json";
import type {
  AgentMcpServerInput,
  AgentMultiagentInput,
  AgentSkillInput,
  AgentToolInput,
} from "../domain/agent-definition";
import type { AgentAcpConfig, AgentRuntimeBinding } from "../domain/agent";

/** OpenAI / Anthropic wire field names (snake_case) — not application port surface types. */
export interface AgentContextManagementEditWireInput {
  type: "compact" | "compact_20260112";
  trigger?: { type: "input_tokens"; value: number };
  instructions?: string;
  pause_after_compaction?: boolean;
}

export interface AgentContextManagementWireInput {
  edits: AgentContextManagementEditWireInput[];
}

export interface AgentOpenAiModelSettingsWireInput {
  max_tokens?: number;
  context_management?: Array<{
    type: "compaction";
    compact_threshold: number;
  }>;
}

export interface AgentModelInput {
  id: string;
  effort?: AgentEffortLevel | null;
  inferenceGeo?: string | null;
  providerOptions?: JsonObject | null;
  speed?: AgentSpeed | null;
  maxTokens?: number | null;
}

export interface AgentOpenMaInput {
  auxiliaryModel?: string | AgentModelInput | null;
  appendablePrompts?: string[] | null;
  contextManagement?: AgentContextManagementWireInput | null;
  openaiModelSettings?: AgentOpenAiModelSettingsWireInput | null;
  harness?: string | null;
  acp?: AgentAcpConfig | null;
  runtimeBinding?: AgentRuntimeBinding | null;
  enableGeneralSubagent?: boolean | null;
  /** Internal protocol-adapter state, never accepted from the public API. */
  compatibility?: JsonObject | null;
}

export type {
  AgentMcpServerInput,
  AgentMultiagentInput,
  AgentSkillInput,
  AgentToolInput,
} from "../domain/agent-definition";
