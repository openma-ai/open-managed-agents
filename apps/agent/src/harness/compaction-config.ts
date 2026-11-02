import type { Api, Model } from "@earendil-works/pi-ai";
import {
  PI_CONTEXT_OUTPUT_RESERVE_TOKENS,
  piCompactionInputBudget,
} from "./pi-compaction";

export interface HarnessContextManagementEdit {
  type: "compact" | "compact_20260112";
  trigger?: { type: "input_tokens"; value: number };
  instructions?: string;
}

export interface HarnessContextManagement {
  edits: HarnessContextManagementEdit[];
}

export interface HarnessOpenAiModelSettings {
  max_tokens?: number;
  context_management?: Array<{
    type: "compaction";
    compact_threshold: number;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOma(agent: unknown): Record<string, unknown> | undefined {
  if (!isRecord(agent)) return undefined;
  const oma = agent._oma;
  return isRecord(oma) ? oma : undefined;
}

function readContextManagement(agent: unknown): HarnessContextManagement | undefined {
  if (!isRecord(agent)) return undefined;
  const direct = agent.context_management;
  if (isRecord(direct)) return direct as unknown as HarnessContextManagement;
  const oma = readOma(agent);
  const nested = oma?.context_management;
  if (isRecord(nested)) return nested as unknown as HarnessContextManagement;
  return undefined;
}

function readOpenAiModelSettings(agent: unknown): HarnessOpenAiModelSettings | undefined {
  const oma = readOma(agent);
  const nested = oma?.model_settings;
  if (isRecord(nested)) return nested as unknown as HarnessOpenAiModelSettings;
  if (!isRecord(agent)) return undefined;
  const direct = agent.model_settings;
  if (isRecord(direct)) return direct as unknown as HarnessOpenAiModelSettings;
  return undefined;
}

function isCompactEditType(type: string): boolean {
  return type === "compact" || type === "compact_20260112";
}

function normalizeTriggerFraction(value: number | undefined): number {
  if (value === undefined) return 1;
  return Math.min(0.95, Math.max(0.01, value));
}

/**
 * Input-token threshold at which Pi compaction should run.
 * Default: context_window - max_tokens - safety margin (pi-ai catalog values).
 */
export function resolveCompactionTriggerInputTokens(
  model: Model<Api>,
  agent: unknown,
  metadata?: Record<string, unknown>,
): number {
  const budget = piCompactionInputBudget(model);
  const contextManagement = readContextManagement(agent);
  const compactEdit = contextManagement?.edits?.find((edit) =>
    isCompactEditType(edit.type),
  );
  const explicit = compactEdit?.trigger;
  if (explicit?.type === "input_tokens" && Number.isFinite(explicit.value)) {
    return explicit.value;
  }
  const openAi = readOpenAiModelSettings(agent);
  const openAiCompaction = openAi?.context_management?.find(
    (entry) => entry.type === "compaction",
  );
  if (
    openAiCompaction !== undefined
    && Number.isFinite(openAiCompaction.compact_threshold)
  ) {
    return openAiCompaction.compact_threshold;
  }
  const fraction = typeof metadata?.compaction_trigger_fraction === "number"
    && Number.isFinite(metadata.compaction_trigger_fraction)
    ? metadata.compaction_trigger_fraction
    : undefined;
  return budget * normalizeTriggerFraction(fraction);
}

export function resolveCompactionSummaryInstructions(agent: unknown): string | undefined {
  const contextManagement = readContextManagement(agent);
  const compactEdit = contextManagement?.edits?.find((edit) =>
    isCompactEditType(edit.type),
  );
  const instructions = compactEdit?.instructions;
  return typeof instructions === "string" && instructions.trim().length > 0
    ? instructions
    : undefined;
}

export { PI_CONTEXT_OUTPUT_RESERVE_TOKENS };
