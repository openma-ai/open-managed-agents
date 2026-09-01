export interface ModelCapabilitySupport {
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

export interface ModelThinkingCapability {
  supported: boolean;
  types: {
    adaptive: ModelCapabilitySupport;
    enabled: ModelCapabilitySupport;
  };
}

export interface ModelCapabilities {
  batch: ModelCapabilitySupport;
  citations: ModelCapabilitySupport;
  codeExecution: ModelCapabilitySupport;
  contextManagement: ModelContextManagementCapability;
  effort: ModelEffortCapability;
  imageInput: ModelCapabilitySupport;
  pdfInput: ModelCapabilitySupport;
  structuredOutputs: ModelCapabilitySupport;
  thinking: ModelThinkingCapability;
}

export interface Model {
  id: string;
  allowedFallbackModels: string[] | null;
  capabilities: ModelCapabilities | null;
  createdAt: string;
  displayName: string;
  maxInputTokens: number | null;
  maxTokens: number | null;
}
