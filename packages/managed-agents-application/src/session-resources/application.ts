import type { SessionResource } from "../domain/session-resource";
import type {
  AddSessionFileResourceCommand,
  AddSessionResourceResult,
  DeleteSessionResourceCommand,
  DeleteSessionResourceResult,
  ListSessionResourcesQuery,
  ListSessionResourcesResult,
  RetrieveSessionResourceQuery,
  RetrieveSessionResourceResult,
  SessionResourcesApplicationPort,
  UpdateSessionResourceCommand,
  UpdateSessionResourceResult,
} from "../ports/session-resources";
import type { SessionFileSourcePort } from "./file-source";
import type { SessionResourceStore } from "@open-managed-agents/session-resource-store";

export interface SessionResourcesApplicationServiceDependencies {
  workspaceId: string;
  store: SessionResourceStore;
  files: SessionFileSourcePort;
  clock: { now(): Date };
  ids: { nextResourceId(): string };
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function resourceKey(resource: SessionResource): string {
  return resource.type === "memory_store"
    ? `memory_store:${resource.memoryStoreId}`
    : `${resource.type}:${resource.id}`;
}

function encodeCursor(key: string): string {
  return `session-resources.${btoa(encodeURIComponent(key))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`;
}

function decodeCursor(value: string): string | null {
  const [scope, encoded, extra] = value.split(".");
  if (
    scope !== "session-resources" ||
    encoded === undefined ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) return null;
  const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursor(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function validMountPath(value: string): boolean {
  return value.startsWith("/") && !value.split("/").includes("..");
}

export class SessionResourcesApplicationService
  implements SessionResourcesApplicationPort
{
  constructor(
    private readonly dependencies: SessionResourcesApplicationServiceDependencies,
  ) {}

  async listSessionResources(
    query: ListSessionResourcesQuery,
  ): Promise<ListSessionResourcesResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
    });
    if (current === null) return { type: "not_found" };
    const cursorKey =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (cursorKey === null) {
      return {
        type: "invalid_request",
        message: "Invalid session resources page cursor",
      };
    }
    const start =
      cursorKey === undefined
        ? 0
        : current.resources.findIndex(
            (resource) => resourceKey(resource) === cursorKey,
          ) + 1;
    if (cursorKey !== undefined && start === 0) {
      return {
        type: "invalid_request",
        message: "Invalid session resources page cursor",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const resources = current.resources.slice(start, start + pageSize);
    const hasMore = start + resources.length < current.resources.length;
    const last = resources[resources.length - 1];
    return {
      type: "page",
      page: {
        resources,
        nextCursor:
          hasMore && last !== undefined ? encodeCursor(resourceKey(last)) : null,
      },
    };
  }

  async retrieveSessionResource(
    query: RetrieveSessionResourceQuery,
  ): Promise<RetrieveSessionResourceResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: query.sessionId,
    });
    if (current === null) return { type: "not_found" };
    const resource = current.resources.find((candidate) =>
      candidate.type === "memory_store"
        ? candidate.memoryStoreId === query.resourceId
        : candidate.id === query.resourceId,
    );
    return resource === undefined
      ? { type: "not_found" }
      : { type: "found", resource };
  }

  async updateSessionResource(
    command: UpdateSessionResourceCommand,
  ): Promise<UpdateSessionResourceResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
    });
    if (current === null) return { type: "not_found" };
    const index = current.resources.findIndex(
      (resource) =>
        resource.type !== "memory_store" && resource.id === command.resourceId,
    );
    const existing = current.resources[index];
    if (existing === undefined) return { type: "not_found" };
    if (existing.type !== "github_repository") {
      return {
        type: "invalid_request",
        message: "Only GitHub repository resources support token rotation",
      };
    }
    if (command.authorizationToken.length === 0) {
      return {
        type: "invalid_request",
        message: "GitHub authorization token must not be empty",
      };
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    const resource: Extract<SessionResource, { type: "github_repository" }> = {
      ...existing,
      updatedAt: timestamp,
    };
    const resources = [...current.resources];
    resources[index] = resource;
    const replaced = await this.dependencies.store.replaceCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
      expectedRevision: current.revision,
      resources,
      updatedAt: timestamp,
      secretChanges: [
        {
          type: "store_github_token",
          resourceId: resource.id,
          authorizationToken: command.authorizationToken,
        },
      ],
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Session changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "updated", resource };
  }

  async deleteSessionResource(
    command: DeleteSessionResourceCommand,
  ): Promise<DeleteSessionResourceResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
    });
    if (current === null) return { type: "not_found" };
    const index = current.resources.findIndex((resource) =>
      resource.type === "memory_store"
        ? resource.memoryStoreId === command.resourceId
        : resource.id === command.resourceId,
    );
    const existing = current.resources[index];
    if (existing === undefined) return { type: "not_found" };
    const timestamp = this.dependencies.clock.now().toISOString();
    const replaced = await this.dependencies.store.replaceCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
      expectedRevision: current.revision,
      resources: current.resources.filter((_, resourceIndex) => resourceIndex !== index),
      updatedAt: timestamp,
      secretChanges:
        existing.type === "github_repository"
          ? [
              {
                type: "delete_github_token" as const,
                resourceId: existing.id,
              },
            ]
          : [],
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Session changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "deleted", resourceId: command.resourceId };
  }

  async addSessionFileResource(
    command: AddSessionFileResourceCommand,
  ): Promise<AddSessionResourceResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
    });
    if (current === null) return { type: "not_found" };
    const file = await this.dependencies.files.find({
      workspaceId: this.dependencies.workspaceId,
      fileId: command.fileId,
    });
    if (file === null) {
      return {
        type: "dependency_not_found",
        message: `File ${command.fileId} was not found`,
      };
    }
    const mountPath = command.mountPath ?? `/mnt/session/uploads/${command.fileId}`;
    if (!validMountPath(mountPath)) {
      return {
        type: "invalid_request",
        message: "Session resource mount path must be absolute and may not traverse parents",
      };
    }
    if (current.resources.some((resource) => resource.mountPath === mountPath)) {
      return {
        type: "invalid_request",
        message: `Session resource mount path ${mountPath} is already in use`,
      };
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    const resource: Extract<SessionResource, { type: "file" }> = {
      id: this.dependencies.ids.nextResourceId(),
      type: "file",
      createdAt: timestamp,
      fileId: command.fileId,
      mountPath,
      updatedAt: timestamp,
    };
    const replaced = await this.dependencies.store.replaceCurrent({
      workspaceId: this.dependencies.workspaceId,
      sessionId: command.sessionId,
      expectedRevision: current.revision,
      resources: [...current.resources, resource],
      updatedAt: timestamp,
      secretChanges: [],
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Session changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "added", resource };
  }
}
