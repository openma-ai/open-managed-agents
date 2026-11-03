import type { ModelListQuery } from "../contracts/models";
import type {
  ListModelsQuery,
  Model,
} from "../ports/models";

export function toListModelsQuery(query: ModelListQuery): ListModelsQuery {
  const lifecycle = query.lifecycle === undefined
    ? undefined
    : Array.isArray(query.lifecycle)
      ? query.lifecycle
      : [query.lifecycle];
  return {
    ...(query.after_id !== undefined && { afterId: query.after_id }),
    ...(query.before_id !== undefined && { beforeId: query.before_id }),
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(lifecycle !== undefined && { lifecycle }),
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
          compaction: capabilities.compaction === null
            ? null
            : {
                summarize: capabilities.compaction.summarize,
                supported: capabilities.compaction.supported,
              },
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
          server_tools: {
            code_execution: capabilities.serverTools.codeExecution,
            supported: capabilities.serverTools.supported,
            web_search: capabilities.serverTools.webSearch,
          },
          structured_outputs: capabilities.structuredOutputs,
          thinking: {
            supported: capabilities.thinking.supported,
            types: {
              adaptive: capabilities.thinking.types.adaptive,
              between_tools: capabilities.thinking.types.betweenTools,
              disabled: capabilities.thinking.types.disabled,
              enabled: capabilities.thinking.types.enabled,
            },
          },
        },
    created_at: model.createdAt,
    deprecated_at: model.deprecatedAt,
    display_name: model.displayName,
    lifecycle: model.lifecycle,
    line: model.line,
    max_input_tokens: model.maxInputTokens,
    max_tokens: model.maxTokens,
    retires_at: model.retiresAt,
    type: "model",
  };
}
