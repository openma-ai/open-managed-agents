import type {
  SessionResourceAddBody,
  SessionResourceListQuery,
  SessionResourceUpdateBody,
} from "../contracts/session-resources";
import type {
  AddSessionFileResourceCommand,
  DeleteSessionResourceCommand,
  ListSessionResourcesQuery,
  RepositoryCheckout,
  RetrieveSessionResourceQuery,
  SessionResourceView,
  UpdateSessionResourceCommand,
} from "../ports/session-resources";

export function toRetrieveSessionResourceQuery(
  sessionId: string,
  resourceId: string,
): RetrieveSessionResourceQuery {
  return { sessionId, resourceId };
}

export function toDeleteSessionResourceCommand(
  sessionId: string,
  resourceId: string,
): DeleteSessionResourceCommand {
  return { sessionId, resourceId };
}

export function toUpdateSessionResourceCommand(
  sessionId: string,
  resourceId: string,
  body: SessionResourceUpdateBody,
): UpdateSessionResourceCommand {
  return {
    sessionId,
    resourceId,
    authorizationToken: body.authorization_token,
  };
}

export function toAddSessionFileResourceCommand(
  sessionId: string,
  body: SessionResourceAddBody,
): AddSessionFileResourceCommand {
  return {
    sessionId,
    fileId: body.file_id,
    ...(body.mount_path !== undefined && { mountPath: body.mount_path }),
  };
}

export function toListSessionResourcesQuery(
  sessionId: string,
  query: SessionResourceListQuery,
): ListSessionResourcesQuery {
  return {
    sessionId,
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
  };
}

function fromRepositoryCheckout(checkout: RepositoryCheckout): object {
  return checkout.type === "branch"
    ? { type: checkout.type, name: checkout.name }
    : { type: checkout.type, sha: checkout.sha };
}

export function toSessionResourceResponse(resource: SessionResourceView): object {
  switch (resource.type) {
    case "file":
      return {
        id: resource.id,
        created_at: resource.createdAt,
        file_id: resource.fileId,
        mount_path: resource.mountPath,
        type: resource.type,
        updated_at: resource.updatedAt,
      };
    case "github_repository":
      return {
        id: resource.id,
        created_at: resource.createdAt,
        mount_path: resource.mountPath,
        type: resource.type,
        updated_at: resource.updatedAt,
        url: resource.url,
        ...(resource.checkout !== undefined && {
          checkout:
            resource.checkout === null
              ? null
              : fromRepositoryCheckout(resource.checkout),
        }),
      };
    case "memory_store":
      return {
        memory_store_id: resource.memoryStoreId,
        type: resource.type,
        ...(resource.access !== undefined && { access: resource.access }),
        ...(resource.description !== undefined && {
          description: resource.description,
        }),
        ...(resource.instructions !== undefined && {
          instructions: resource.instructions,
        }),
        ...(resource.mountPath !== undefined && {
          mount_path: resource.mountPath,
        }),
        ...(resource.name !== undefined && { name: resource.name }),
      };
  }
}
