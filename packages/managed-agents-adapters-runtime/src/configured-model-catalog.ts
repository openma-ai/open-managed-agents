import type {
  FindCatalogModel,
  ListCatalogModels,
  ListCatalogModelsResult,
  Model,
  ModelCatalogSourcePort,
} from "@open-managed-agents/managed-agents-application";

export class ConfiguredModelCatalogSource implements ModelCatalogSourcePort {
  private readonly models: Model[];

  constructor(models: Model[]) {
    const ids = new Set<string>();
    for (const model of models) {
      if (ids.has(model.id)) {
        throw new Error(`Duplicate configured Model id ${model.id}`);
      }
      ids.add(model.id);
      if (
        Number.isNaN(Date.parse(model.createdAt)) ||
        new Date(model.createdAt).toISOString() !== model.createdAt
      ) {
        throw new Error(`Configured Model ${model.id} has an invalid createdAt`);
      }
    }
    this.models = structuredClone(models).sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt) ||
      right.id.localeCompare(left.id)
    );
  }

  async find(input: FindCatalogModel): Promise<Model | null> {
    const model = this.models.find((candidate) => candidate.id === input.modelId);
    return model === undefined ? null : structuredClone(model);
  }

  async list(input: ListCatalogModels): Promise<ListCatalogModelsResult> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Configured Model page limit must be a positive integer");
    }
    const positionId = input.afterId ?? input.beforeId;
    const position = positionId === undefined
      ? undefined
      : this.models.findIndex((model) => model.id === positionId);
    if (position === -1) return { type: "invalid_position" };

    if (input.beforeId !== undefined && position !== undefined) {
      const start = Math.max(0, position - input.limit);
      return {
        type: "page",
        models: structuredClone(this.models.slice(start, position)),
        hasMore: start > 0,
      };
    }

    const start = position === undefined ? 0 : position + 1;
    const end = start + input.limit;
    return {
      type: "page",
      models: structuredClone(this.models.slice(start, end)),
      hasMore: end < this.models.length,
    };
  }
}
