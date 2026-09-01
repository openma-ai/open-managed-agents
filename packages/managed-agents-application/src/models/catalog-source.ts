import type { Model } from "../domain/model";

export interface FindCatalogModel {
  workspaceId: string;
  modelId: string;
}

export interface ListCatalogModels {
  workspaceId: string;
  limit: number;
  afterId?: string;
  beforeId?: string;
}

export type ListCatalogModelsResult =
  | { type: "page"; models: Model[]; hasMore: boolean }
  | { type: "invalid_position" };

export interface ModelCatalogSourcePort {
  find(input: FindCatalogModel): Promise<Model | null>;
  list(input: ListCatalogModels): Promise<ListCatalogModelsResult>;
}
