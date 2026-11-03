import type { Model, ModelLifecycle } from "../domain/model";
export type { Model, ModelLifecycle } from "../domain/model";

export interface RetrieveModelQuery {
  modelId: string;
}

export interface ListModelsQuery {
  afterId?: string;
  beforeId?: string;
  pageSize?: number;
  /**
   * Lifecycle stages to include. When omitted the catalogue lists the active
   * and deprecated models; retired models appear only when asked for.
   */
  lifecycle?: ModelLifecycle[];
}

export interface ModelsPage {
  models: Model[];
  hasMore: boolean;
}

export type RetrieveModelResult =
  | { type: "found"; model: Model }
  | { type: "not_found" };

export type ListModelsResult =
  | { type: "page"; page: ModelsPage }
  | { type: "invalid_request"; message: string };

export interface ModelsApplicationPort {
  retrieveModel(query: RetrieveModelQuery): Promise<RetrieveModelResult>;
  listModels(query: ListModelsQuery): Promise<ListModelsResult>;
}
