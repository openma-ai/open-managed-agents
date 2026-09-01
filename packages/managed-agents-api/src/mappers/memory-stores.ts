import type {
  MemoryStoreCreateBody,
  MemoryStoreListQuery,
  MemoryStoreUpdateBody,
} from "../contracts/memory-stores";
import type {
  ArchiveMemoryStoreCommand,
  CreateMemoryStoreCommand,
  DeleteMemoryStoreCommand,
  ListMemoryStoresQuery,
  MemoryStoreView,
  RetrieveMemoryStoreQuery,
  UpdateMemoryStoreCommand,
} from "../ports/memory-stores";

export function toCreateMemoryStoreCommand(
  body: MemoryStoreCreateBody,
): CreateMemoryStoreCommand {
  return {
    name: body.name,
    ...(body.description !== undefined && { description: body.description }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
  };
}

export function toRetrieveMemoryStoreQuery(
  memoryStoreId: string,
): RetrieveMemoryStoreQuery {
  return { memoryStoreId };
}

export function toUpdateMemoryStoreCommand(
  memoryStoreId: string,
  body: MemoryStoreUpdateBody,
): UpdateMemoryStoreCommand {
  return {
    memoryStoreId,
    ...(body.description !== undefined && { description: body.description }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.name !== undefined && { name: body.name }),
  };
}

export function toListMemoryStoresQuery(
  query: MemoryStoreListQuery,
): ListMemoryStoresQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query["created_at[gte]"] !== undefined && {
      createdAtOrAfter: query["created_at[gte]"],
    }),
    ...(query["created_at[lte]"] !== undefined && {
      createdAtOrBefore: query["created_at[lte]"],
    }),
    ...(query.include_archived !== undefined && {
      includeArchived: query.include_archived,
    }),
  };
}

export function toDeleteMemoryStoreCommand(
  memoryStoreId: string,
): DeleteMemoryStoreCommand {
  return { memoryStoreId };
}

export function toArchiveMemoryStoreCommand(
  memoryStoreId: string,
): ArchiveMemoryStoreCommand {
  return { memoryStoreId };
}

export function toMemoryStoreResponse(store: MemoryStoreView): object {
  return {
    id: store.id,
    created_at: store.createdAt,
    name: store.name,
    type: "memory_store",
    updated_at: store.updatedAt,
    ...(store.archivedAt !== undefined && { archived_at: store.archivedAt }),
    ...(store.description !== undefined && { description: store.description }),
    ...(store.metadata !== undefined && { metadata: store.metadata }),
  };
}
