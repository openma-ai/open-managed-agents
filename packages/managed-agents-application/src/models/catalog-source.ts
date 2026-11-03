import type { Model, ModelLifecycle } from "../domain/model";

export interface FindCatalogModel {
  workspaceId: string;
  modelId: string;
}

export interface ListCatalogModels {
  workspaceId: string;
  limit: number;
  afterId?: string;
  beforeId?: string;
  /**
   * Lifecycle stages to include. When omitted the catalogue lists the active
   * and deprecated models; retired models appear only when asked for.
   */
  lifecycle?: ModelLifecycle[];
}

export type ListCatalogModelsResult =
  | { type: "page"; models: Model[]; hasMore: boolean }
  | { type: "invalid_position" };

export interface ModelCatalogSourcePort {
  find(input: FindCatalogModel): Promise<Model | null>;
  list(input: ListCatalogModels): Promise<ListCatalogModelsResult>;
}
