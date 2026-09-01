import type {
  MemoryCreateBody,
  MemoryListQuery,
  MemoryRetrieveQuery,
  MemoryUpdateBody,
} from "../contracts/memories";
import type {
  CreateMemoryCommand,
  DeleteMemoryCommand,
  ListMemoriesQuery,
  MemoryListItemView,
  MemoryView,
  RetrieveMemoryQuery,
  UpdateMemoryCommand,
} from "../ports/memories";

export function toCreateMemoryCommand(
  memoryStoreId: string,
  body: MemoryCreateBody,
  query: MemoryRetrieveQuery,
): CreateMemoryCommand {
  return {
    memoryStoreId,
    content: body.content,
    path: body.path,
    ...(query.view !== undefined && { projection: query.view }),
  };
}

export function toRetrieveMemoryQuery(
  memoryStoreId: string,
  memoryId: string,
  query: MemoryRetrieveQuery,
): RetrieveMemoryQuery {
  return {
    memoryStoreId,
    memoryId,
    ...(query.view !== undefined && { projection: query.view }),
  };
}

export function toUpdateMemoryCommand(
  memoryStoreId: string,
  memoryId: string,
  body: MemoryUpdateBody,
  query: MemoryRetrieveQuery,
): UpdateMemoryCommand {
  return {
    memoryStoreId,
    memoryId,
    ...(query.view !== undefined && { projection: query.view }),
    ...(body.content !== undefined && { content: body.content }),
    ...(body.path !== undefined && { path: body.path }),
    ...(body.precondition !== undefined && {
      contentPrecondition: {
        ...(body.precondition.content_sha256 !== undefined && {
          expectedSha256: body.precondition.content_sha256,
        }),
      },
    }),
  };
}

export function toListMemoriesQuery(
  memoryStoreId: string,
  query: MemoryListQuery,
): ListMemoriesQuery {
  return {
    memoryStoreId,
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query.depth !== undefined && { depth: query.depth }),
    ...(query.path_prefix !== undefined && { pathPrefix: query.path_prefix }),
    ...(query.view !== undefined && { projection: query.view }),
  };
}

export function toDeleteMemoryCommand(
  memoryStoreId: string,
  memoryId: string,
  expectedContentSha256: string | undefined,
): DeleteMemoryCommand {
  return {
    memoryStoreId,
    memoryId,
    ...(expectedContentSha256 !== undefined && { expectedContentSha256 }),
  };
}

export function toMemoryResponse(memory: MemoryView): object {
  return {
    id: memory.id,
    content_sha256: memory.contentSha256,
    content_size_bytes: memory.contentSizeBytes,
    created_at: memory.createdAt,
    memory_store_id: memory.memoryStoreId,
    memory_version_id: memory.memoryVersionId,
    path: memory.path,
    type: "memory",
    updated_at: memory.updatedAt,
    ...(memory.content !== undefined && { content: memory.content }),
  };
}

export function toMemoryListItemResponse(item: MemoryListItemView): object {
  return item.kind === "prefix"
    ? { path: item.path, type: "memory_prefix" }
    : toMemoryResponse(item);
}
