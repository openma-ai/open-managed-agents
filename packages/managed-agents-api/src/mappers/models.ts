import type { ModelListQuery } from "../contracts/models";
import type {
  ListModelsQuery,
  Model,
} from "../ports/models";

export function toListModelsQuery(query: ModelListQuery): ListModelsQuery {
  return {
    ...(query.after_id !== undefined && { afterId: query.after_id }),
    ...(query.before_id !== undefined && { beforeId: query.before_id }),
    ...(query.limit !== undefined && { pageSize: query.limit }),
  };
}

export function toModelResponse(model: Model): object {
  const capabilities = model.capabilities;
  return {
    id: model.id,
    allowed_fallback_models: model.allowedFallbackModels,
    capabilities: capabilities === null
      ? null
      : {
          batch: capabilities.batch,
          citations: capabilities.citations,
          code_execution: capabilities.codeExecution,
          context_management: {
            clear_thinking_20251015:
              capabilities.contextManagement.clearThinking20251015,
            clear_tool_uses_20250919:
              capabilities.contextManagement.clearToolUses20250919,
            compact_20260112:
              capabilities.contextManagement.compact20260112,
            supported: capabilities.contextManagement.supported,
          },
          effort: capabilities.effort,
          image_input: capabilities.imageInput,
          pdf_input: capabilities.pdfInput,
          structured_outputs: capabilities.structuredOutputs,
          thinking: capabilities.thinking,
        },
    created_at: model.createdAt,
    display_name: model.displayName,
    max_input_tokens: model.maxInputTokens,
    max_tokens: model.maxTokens,
    type: "model",
  };
}
