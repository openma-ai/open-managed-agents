import type {
  MemoryVersionListQuery,
  MemoryVersionRetrieveQuery,
} from "../contracts/memory-versions";
import type {
  ListMemoryVersionsQuery,
  MemoryVersionActorView,
  MemoryVersionView,
  RedactMemoryVersionCommand,
  RetrieveMemoryVersionQuery,
} from "../ports/memory-versions";

export function toRetrieveMemoryVersionQuery(
  memoryStoreId: string,
  memoryVersionId: string,
  query: MemoryVersionRetrieveQuery,
): RetrieveMemoryVersionQuery {
  return {
    memoryStoreId,
    memoryVersionId,
    ...(query.view !== undefined && { projection: query.view }),
  };
}

export function toListMemoryVersionsQuery(
  memoryStoreId: string,
  query: MemoryVersionListQuery,
): ListMemoryVersionsQuery {
  return {
    memoryStoreId,
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query.api_key_id !== undefined && { apiKeyId: query.api_key_id }),
    ...(query["created_at[gte]"] !== undefined && {
      createdAtOrAfter: query["created_at[gte]"],
    }),
    ...(query["created_at[lte]"] !== undefined && {
      createdAtOrBefore: query["created_at[lte]"],
    }),
    ...(query.memory_id !== undefined && { memoryId: query.memory_id }),
    ...(query.operation !== undefined && { operation: query.operation }),
    ...(query.service_account_id !== undefined && {
      serviceAccountId: query.service_account_id,
    }),
    ...(query.session_id !== undefined && { sessionId: query.session_id }),
    ...(query.view !== undefined && { projection: query.view }),
  };
}

export function toRedactMemoryVersionCommand(
  memoryStoreId: string,
  memoryVersionId: string,
): RedactMemoryVersionCommand {
  return { memoryStoreId, memoryVersionId };
}

function toActorResponse(actor: MemoryVersionActorView): object {
  switch (actor.kind) {
    case "api":
      return { api_key_id: actor.apiKeyId, type: "api_actor" };
    case "service_account":
      return {
        service_account_id: actor.serviceAccountId,
        type: "service_account_actor",
      };
    case "session":
      return { session_id: actor.sessionId, type: "session_actor" };
    case "user":
      return { type: "user_actor", user_id: actor.userId };
  }
}

export function toMemoryVersionResponse(version: MemoryVersionView): object {
  return {
    id: version.id,
    created_at: version.createdAt,
    memory_id: version.memoryId,
    memory_store_id: version.memoryStoreId,
    operation: version.operation,
    type: "memory_version",
    ...(version.content !== undefined && { content: version.content }),
    ...(version.contentSha256 !== undefined && {
      content_sha256: version.contentSha256,
    }),
    ...(version.contentSizeBytes !== undefined && {
      content_size_bytes: version.contentSizeBytes,
    }),
    ...(version.createdBy !== undefined && {
      created_by: toActorResponse(version.createdBy),
    }),
    ...(version.path !== undefined && { path: version.path }),
    ...(version.redactedAt !== undefined && {
      redacted_at: version.redactedAt,
    }),
    ...(version.redactedBy !== undefined && {
      redacted_by: toActorResponse(version.redactedBy),
    }),
  };
}
