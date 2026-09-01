import type { Model } from "../domain/model";
export type { Model } from "../domain/model";

export interface RetrieveModelQuery {
  modelId: string;
}

export interface ListModelsQuery {
  afterId?: string;
  beforeId?: string;
  pageSize?: number;
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
