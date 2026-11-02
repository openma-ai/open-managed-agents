import type {
  AgentContextManagement,
  AgentOpenAiModelSettings,
  AgentOpenMaExtensions,
} from "../domain/agent";
import type {
  AgentContextManagementInput,
  AgentOpenMaInput,
  AgentOpenAiModelSettingsInput,
} from "./port";

export interface ParsedCompactionWire {
  compactThresholdInputTokens?: number;
  instructions?: string;
  pauseAfterCompaction?: boolean;
  modelMaxTokensFromOpenAi?: number;
}

function isCompactEditType(type: string): boolean {
  return type === "compact" || type === "compact_20260112";
}

export function parseAnthropicContextManagement(
  contextManagement: AgentContextManagementInput | null | undefined,
): ParsedCompactionWire | null {
  if (contextManagement == null) return null;
  const edit = contextManagement.edits.find((entry) => isCompactEditType(entry.type));
  if (edit === undefined) return null;
  return {
    ...(edit.trigger?.type === "input_tokens" && Number.isFinite(edit.trigger.value)
      ? { compactThresholdInputTokens: edit.trigger.value }
      : {}),
    ...(typeof edit.instructions === "string" && edit.instructions.length > 0
      ? { instructions: edit.instructions }
      : {}),
    ...(edit.pause_after_compaction === true
      ? { pauseAfterCompaction: true }
      : {}),
  };
}

export function parseOpenAiModelSettings(
  modelSettings: AgentOpenAiModelSettingsInput | null | undefined,
): ParsedCompactionWire | null {
  if (modelSettings == null) return null;
  const compaction = modelSettings.context_management?.find(
    (entry) => entry.type === "compaction",
  );
  if (compaction === undefined && modelSettings.max_tokens === undefined) {
    return null;
  }
  return {
    ...(compaction !== undefined && Number.isFinite(compaction.compact_threshold)
      ? { compactThresholdInputTokens: compaction.compact_threshold }
      : {}),
    ...(typeof modelSettings.max_tokens === "number"
      ? { modelMaxTokensFromOpenAi: modelSettings.max_tokens }
      : {}),
  };
}

function thresholdsConflict(left?: number, right?: number): boolean {
  if (left === undefined || right === undefined) return false;
  return left !== right;
}

export function resolveCompactionWireInput(
  openma: AgentOpenMaInput | null | undefined,
): { type: "ok"; patch: Partial<AgentOpenMaExtensions> } | { type: "error"; message: string } {
  if (openma == null) return { type: "ok", patch: {} };

  const anthropic = parseAnthropicContextManagement(openma.contextManagement);
  const openai = parseOpenAiModelSettings(openma.openaiModelSettings);

  if (
    thresholdsConflict(
      anthropic?.compactThresholdInputTokens,
      openai?.compactThresholdInputTokens,
    )
  ) {
    return {
      type: "error",
      message:
        "Conflicting compaction thresholds between _oma.context_management and _oma.model_settings",
    };
  }

  if (
    anthropic?.compactThresholdInputTokens !== undefined
    && openai?.compactThresholdInputTokens !== undefined
  ) {
    return {
      type: "error",
      message:
        "Provide compaction via either _oma.context_management or _oma.model_settings, not both",
    };
  }

  const patch: Partial<AgentOpenMaExtensions> = {};

  if (openma.contextManagement != null) {
    patch.contextManagement = structuredClone(
      openma.contextManagement,
    ) as AgentContextManagement;
    patch.compactionWireFormat = "anthropic_context_management";
  }
  if (openma.openaiModelSettings != null) {
    patch.openaiModelSettings = structuredClone(
      openma.openaiModelSettings,
    ) as AgentOpenAiModelSettings;
    if (patch.compactionWireFormat === undefined) {
      patch.compactionWireFormat = "openai_model_settings";
    }
  }

  return { type: "ok", patch };
}
