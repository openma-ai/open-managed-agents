import type {
  FindCatalogModel,
  ListCatalogModels,
  ListCatalogModelsResult,
  Model,
  ModelCatalogSourcePort,
} from "@open-managed-agents/managed-agents-application";

export interface ModelCardCatalogRecord {
  model_id: string;
  created_at: string;
  archived_at: string | null;
}

export interface ModelCardCatalogReader {
  list(input: { tenantId: string }): Promise<ModelCardCatalogRecord[]>;
  findByModelId(input: {
    tenantId: string;
    modelId: string;
  }): Promise<ModelCardCatalogRecord | null>;
}

/**
 * Adapts the tenant's executable model-card registry to the public Managed
 * Agents Models Port. Provider credentials deliberately stay behind the
 * model-card service boundary and never enter the SDK response shape.
 */
export class ModelCardCatalogSource implements ModelCatalogSourcePort {
  constructor(private readonly cards: ModelCardCatalogReader) {}

  async find(input: FindCatalogModel): Promise<Model | null> {
    const card = await this.cards.findByModelId({
      tenantId: input.workspaceId,
      modelId: input.modelId,
    });
    return card === null || card.archived_at !== null ? null : toModel(card);
  }

  async list(input: ListCatalogModels): Promise<ListCatalogModelsResult> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Model card page limit must be a positive integer");
    }
    const models = (await this.cards.list({ tenantId: input.workspaceId }))
      .filter((card) => card.archived_at === null)
      .map(toModel)
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id)
      );
    const positionId = input.afterId ?? input.beforeId;
    const position = positionId === undefined
      ? undefined
      : models.findIndex((model) => model.id === positionId);
    if (position === -1) return { type: "invalid_position" };

    if (input.beforeId !== undefined && position !== undefined) {
      const start = Math.max(0, position - input.limit);
      return {
        type: "page",
        models: models.slice(start, position),
        hasMore: start > 0,
      };
    }

    const start = position === undefined ? 0 : position + 1;
    const end = start + input.limit;
    return {
      type: "page",
      models: models.slice(start, end),
      hasMore: end < models.length,
    };
  }
}

function toModel(card: ModelCardCatalogRecord): Model {
  return {
    id: card.model_id,
    allowedFallbackModels: null,
    capabilities: null,
    createdAt: card.created_at,
    displayName: card.model_id,
    maxInputTokens: null,
    maxTokens: null,
  };
}
