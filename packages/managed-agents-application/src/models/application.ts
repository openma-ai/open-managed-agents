import type {
  ListModelsQuery,
  ListModelsResult,
  ModelsApplicationPort,
  RetrieveModelQuery,
  RetrieveModelResult,
} from "../ports/models";
import type { ModelCatalogSourcePort } from "./catalog-source";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface ModelsApplicationServiceDependencies {
  workspaceId: string;
  catalog: ModelCatalogSourcePort;
}

export class ModelsApplicationService implements ModelsApplicationPort {
  constructor(
    private readonly dependencies: ModelsApplicationServiceDependencies,
  ) {}

  async retrieveModel(query: RetrieveModelQuery): Promise<RetrieveModelResult> {
    const model = await this.dependencies.catalog.find({
      workspaceId: this.dependencies.workspaceId,
      modelId: query.modelId,
    });
    return model === null
      ? { type: "not_found" }
      : { type: "found", model };
  }

  async listModels(query: ListModelsQuery): Promise<ListModelsResult> {
    if (query.afterId !== undefined && query.beforeId !== undefined) {
      return {
        type: "invalid_request",
        message: "Models pagination accepts either after_id or before_id, not both",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const result = await this.dependencies.catalog.list({
      workspaceId: this.dependencies.workspaceId,
      limit: pageSize,
      ...(query.afterId !== undefined && { afterId: query.afterId }),
      ...(query.beforeId !== undefined && { beforeId: query.beforeId }),
    });
    if (result.type === "invalid_position") {
      return {
        type: "invalid_request",
        message: "The Models pagination position was not found",
      };
    }
    return {
      type: "page",
      page: { models: result.models, hasMore: result.hasMore },
    };
  }
}
