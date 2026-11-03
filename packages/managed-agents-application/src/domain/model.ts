export interface ModelCapabilitySupport {
  supported: boolean;
}

export interface ModelCompactionCapability {
  summarize: ModelCapabilitySupport;
  supported: boolean;
}

export interface ModelContextManagementCapability {
  clearThinking20251015: ModelCapabilitySupport | null;
  clearToolUses20250919: ModelCapabilitySupport | null;
  compact20260112: ModelCapabilitySupport | null;
  supported: boolean;
}

export interface ModelEffortCapability {
  high: ModelCapabilitySupport;
  low: ModelCapabilitySupport;
  max: ModelCapabilitySupport;
  medium: ModelCapabilitySupport;
  supported: boolean;
  xhigh: ModelCapabilitySupport | null;
}

export interface ModelServerToolsCapability {
  codeExecution: ModelCapabilitySupport;
  supported: boolean;
  webSearch: ModelCapabilitySupport;
}

export interface ModelThinkingTypes {
  adaptive: ModelCapabilitySupport;
  betweenTools: ModelCapabilitySupport;
  disabled: ModelCapabilitySupport;
  enabled: ModelCapabilitySupport;
}

export interface ModelThinkingCapability {
  supported: boolean;
  types: ModelThinkingTypes;
}

export interface ModelCapabilities {
  batch: ModelCapabilitySupport;
  citations: ModelCapabilitySupport;
  codeExecution: ModelCapabilitySupport;
  compaction: ModelCompactionCapability | null;
  contextManagement: ModelContextManagementCapability;
  effort: ModelEffortCapability;
  imageInput: ModelCapabilitySupport;
  pdfInput: ModelCapabilitySupport;
  serverTools: ModelServerToolsCapability;
  structuredOutputs: ModelCapabilitySupport;
  thinking: ModelThinkingCapability;
}

/** Lifecycle stage of a model in the catalogue. */
export type ModelLifecycle = "active" | "deprecated" | "retired";

/** Model line a model belongs to, for example `opus` or `sonnet`. */
export type ModelLine = "haiku" | "sonnet" | "opus" | "fable" | "mythos";

export interface Model {
  id: string;
  allowedFallbackModels: string[] | null;
  capabilities: ModelCapabilities | null;
  createdAt: string;
  /** Set once the model is deprecated; `null` while it is active. */
  deprecatedAt: string | null;
  displayName: string;
  lifecycle: ModelLifecycle;
  /** Model line this model belongs to; `null` when it belongs to no line. */
  line: ModelLine | null;
  maxInputTokens: number | null;
  maxTokens: number | null;
  /** Scheduled retirement date; `null` while none is scheduled. */
  retiresAt: string | null;
}
