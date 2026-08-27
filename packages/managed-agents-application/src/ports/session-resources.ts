import type {
  RepositoryCheckout,
  SessionResource,
} from "../domain/session-resource";

export type { RepositoryCheckout } from "../domain/session-resource";
export type SessionResourceView = SessionResource;

export interface ListSessionResourcesQuery {
  sessionId: string;
  pageSize?: number;
  cursor?: string;
}

export interface SessionResourcesPage {
  resources: SessionResourceView[];
  nextCursor: string | null;
}

export interface AddSessionFileResourceCommand {
  sessionId: string;
  fileId: string;
  mountPath?: string | null;
}

export interface RetrieveSessionResourceQuery {
  sessionId: string;
  resourceId: string;
}

export interface UpdateSessionResourceCommand {
  sessionId: string;
  resourceId: string;
  authorizationToken: string;
}

export interface DeleteSessionResourceCommand {
  sessionId: string;
  resourceId: string;
}

export type ListSessionResourcesResult =
  | { type: "page"; page: SessionResourcesPage }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export type AddSessionResourceResult =
  | { type: "added"; resource: Extract<SessionResourceView, { type: "file" }> }
  | { type: "invalid_request"; message: string }
  | { type: "dependency_not_found"; message: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export type RetrieveSessionResourceResult =
  | { type: "found"; resource: SessionResourceView }
  | { type: "not_found" };

export type UpdateSessionResourceResult =
  | { type: "updated"; resource: SessionResourceView }
  | { type: "invalid_request"; message: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export type DeleteSessionResourceResult =
  | { type: "deleted"; resourceId: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export interface SessionResourcesApplicationPort {
  listSessionResources(query: ListSessionResourcesQuery): Promise<ListSessionResourcesResult>;
  addSessionFileResource(command: AddSessionFileResourceCommand): Promise<AddSessionResourceResult>;
  retrieveSessionResource(query: RetrieveSessionResourceQuery): Promise<RetrieveSessionResourceResult>;
  updateSessionResource(command: UpdateSessionResourceCommand): Promise<UpdateSessionResourceResult>;
  deleteSessionResource(command: DeleteSessionResourceCommand): Promise<DeleteSessionResourceResult>;
}
