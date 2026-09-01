import type {
  Memory,
  MemoryVersion,
  MemoryVersionActor,
} from "@open-managed-agents/domain/memories";
import type {
  MemoryDocumentStore,
  MemoryListPosition,
  StoredMemoryListItem,
} from "@open-managed-agents/memory-document-store";
import type {
  CreateMemoryCommand,
  CreateMemoryResult,
  DeleteMemoryCommand,
  DeleteMemoryResult,
  ListMemoriesQuery,
  ListMemoriesResult,
  MemoryProjection,
  MemoryView,
  RetrieveMemoryQuery,
  RetrieveMemoryResult,
  UpdateMemoryCommand,
  UpdateMemoryResult,
} from "../ports/memories";
import type { MemoriesApplicationPort } from "../ports/memories";
import type { MemoryContentDescriptorPort } from "./content-descriptor";
import type { MemoryStoreForMemorySourcePort } from "./memory-store-source";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_FULL_PAGE_SIZE = 20;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeCursor(item: StoredMemoryListItem): string {
  const path = item.kind === "memory" ? item.record.memory.path : item.path;
  return `memories.${item.kind}.${encodeCursorPart(path)}`;
}

function decodeCursor(value: string): MemoryListPosition | null {
  const [scope, kind, path, extra] = value.split(".");
  if (
    scope !== "memories" ||
    (kind !== "memory" && kind !== "prefix") ||
    path === undefined ||
    extra !== undefined
  ) return null;
  const decodedPath = decodeCursorPart(path);
  return decodedPath === null || decodedPath.length === 0
    ? null
    : { kind, path: decodedPath };
}

function validatePath(path: string): string | null {
  if (!path.startsWith("/")) return "Memory path must start with /";
  if (new TextEncoder().encode(path).byteLength > 1024) {
    return "Memory path must not exceed 1024 UTF-8 bytes";
  }
  if (path.normalize("NFC") !== path) return "Memory path must be NFC-normalized";
  if (/\p{Cc}|\p{Cf}/u.test(path)) {
    return "Memory path must not contain control or format characters";
  }
  const segments = path.slice(1).split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) return "Memory path contains an invalid segment";
  return null;
}

function toView(memory: Memory, projection: MemoryProjection): MemoryView {
  return {
    kind: "memory",
    id: memory.id,
    content: projection === "full" ? memory.content : null,
    contentSha256: memory.contentSha256,
    contentSizeBytes: memory.contentSizeBytes,
    createdAt: memory.createdAt,
    memoryStoreId: memory.memoryStoreId,
    memoryVersionId: memory.memoryVersionId,
    path: memory.path,
    updatedAt: memory.updatedAt,
  };
}

function toVersion(
  memory: Memory,
  versionId: string,
  operation: MemoryVersion["operation"],
  actor: MemoryVersionActor,
  createdAt: string,
): MemoryVersion {
  return {
    id: versionId,
    content: memory.content,
    contentSha256: memory.contentSha256,
    contentSizeBytes: memory.contentSizeBytes,
    createdAt,
    createdBy: actor,
    memoryId: memory.id,
    memoryStoreId: memory.memoryStoreId,
    operation,
    path: memory.path,
    redactedAt: null,
  };
}

export interface MemoriesApplicationServiceDependencies {
  workspaceId: string;
  store: MemoryDocumentStore;
  memoryStores: MemoryStoreForMemorySourcePort;
  content: MemoryContentDescriptorPort;
  actor: MemoryVersionActor;
  clock: { now(): Date };
  ids: {
    nextMemoryId(): string;
    nextMemoryVersionId(): string;
  };
}

export class MemoriesApplicationService implements MemoriesApplicationPort {
  constructor(
    private readonly dependencies: MemoriesApplicationServiceDependencies,
  ) {}

  async createMemory(command: CreateMemoryCommand): Promise<CreateMemoryResult> {
    const invalidPath = validatePath(command.path);
    if (invalidPath !== null) {
      return { type: "invalid_request", message: invalidPath };
    }
    const store = await this.dependencies.memoryStores.find({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: command.memoryStoreId,
    });
    if (store === null || store.archivedAt !== null) return { type: "not_found" };
    const described = await this.dependencies.content.describe({
      content: command.content,
    });
    const timestamp = this.dependencies.clock.now().toISOString();
    const versionId = this.dependencies.ids.nextMemoryVersionId();
    const memory: Memory = {
      id: this.dependencies.ids.nextMemoryId(),
      content: command.content,
      contentSha256: described.sha256,
      contentSizeBytes: described.sizeBytes,
      createdAt: timestamp,
      memoryStoreId: command.memoryStoreId,
      memoryVersionId: versionId,
      path: command.path,
      updatedAt: timestamp,
    };
    const result = await this.dependencies.store.create({
      workspaceId: this.dependencies.workspaceId,
      memory,
      version: toVersion(
        memory,
        versionId,
        "created",
        this.dependencies.actor,
        timestamp,
      ),
    });
    if (result.type === "path_conflict") {
      return {
        type: "path_conflict",
        conflict: {
          message: "Memory path already exists",
          conflictingMemoryId: result.conflictingMemoryId,
          conflictingPath: result.conflictingPath,
        },
      };
    }
    return {
      type: "created",
      memory: toView(result.memory.memory, command.projection ?? "basic"),
    };
  }

  async retrieveMemory(
    query: RetrieveMemoryQuery,
  ): Promise<RetrieveMemoryResult> {
    const record = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: query.memoryStoreId,
      memoryId: query.memoryId,
    });
    return record === null
      ? { type: "not_found" }
      : {
          type: "found",
          memory: toView(record.memory, query.projection ?? "full"),
        };
  }

  async updateMemory(command: UpdateMemoryCommand): Promise<UpdateMemoryResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: command.memoryStoreId,
      memoryId: command.memoryId,
    });
    if (current === null) return { type: "not_found" };
    const path = command.path == null ? current.memory.path : command.path;
    const invalidPath = validatePath(path);
    if (invalidPath !== null) {
      return { type: "invalid_request", message: invalidPath };
    }
    const content =
      command.content === undefined ? current.memory.content : command.content;
    const requestedStateMatches =
      content === current.memory.content && path === current.memory.path;
    const expectedSha256 = command.contentPrecondition?.expectedSha256;
    if (
      expectedSha256 !== undefined &&
      expectedSha256 !== current.memory.contentSha256
    ) {
      return requestedStateMatches
        ? {
            type: "updated",
            memory: toView(
              current.memory,
              command.projection ?? "basic",
            ),
          }
        : {
            type: "precondition_failed",
            message: "Memory content SHA-256 precondition failed",
          };
    }
    if (requestedStateMatches) {
      return {
        type: "updated",
        memory: toView(current.memory, command.projection ?? "basic"),
      };
    }
    const described =
      content === current.memory.content
        ? {
            sha256: current.memory.contentSha256,
            sizeBytes: current.memory.contentSizeBytes,
          }
        : await this.dependencies.content.describe({ content });
    const timestamp = this.dependencies.clock.now().toISOString();
    const versionId = this.dependencies.ids.nextMemoryVersionId();
    const next: Memory = {
      ...current.memory,
      content,
      contentSha256: described.sha256,
      contentSizeBytes: described.sizeBytes,
      memoryVersionId: versionId,
      path,
      updatedAt: timestamp,
    };
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: command.memoryStoreId,
      memoryId: command.memoryId,
      expectedRevision: current.revision,
      next,
      version: toVersion(
        next,
        versionId,
        "modified",
        this.dependencies.actor,
        timestamp,
      ),
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      if (expectedSha256 !== undefined) {
        const latest = await this.dependencies.store.findCurrent({
          workspaceId: this.dependencies.workspaceId,
          memoryStoreId: command.memoryStoreId,
          memoryId: command.memoryId,
        });
        if (latest === null) return { type: "not_found" };
        if (latest.memory.contentSha256 !== expectedSha256) {
          return latest.memory.content === content && latest.memory.path === path
            ? {
                type: "updated",
                memory: toView(
                  latest.memory,
                  command.projection ?? "basic",
                ),
              }
            : {
                type: "precondition_failed",
                message: "Memory content SHA-256 precondition failed",
              };
        }
      }
      return {
        type: "conflict",
        message: `Memory changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    if (replaced.type === "path_conflict") {
      return {
        type: "path_conflict",
        conflict: {
          message: "Memory path already exists",
          conflictingMemoryId: replaced.conflictingMemoryId,
          conflictingPath: replaced.conflictingPath,
        },
      };
    }
    return {
      type: "updated",
      memory: toView(replaced.memory.memory, command.projection ?? "basic"),
    };
  }

  async listMemories(query: ListMemoriesQuery): Promise<ListMemoriesResult> {
    const store = await this.dependencies.memoryStores.find({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: query.memoryStoreId,
    });
    if (store === null || store.archivedAt !== null) return { type: "not_found" };
    const pathPrefix = query.pathPrefix ?? "/";
    if (!pathPrefix.startsWith("/") || !pathPrefix.endsWith("/")) {
      return {
        type: "invalid_request",
        message: "Memory path prefix must start and end with /",
      };
    }
    const position =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (position === null) {
      return { type: "invalid_request", message: "Invalid memory page cursor" };
    }
    const projection = query.projection ?? "basic";
    const maxPageSize =
      projection === "full" ? MAX_FULL_PAGE_SIZE : MAX_PAGE_SIZE;
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      maxPageSize,
    );
    const page = await this.dependencies.store.listCurrent({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: query.memoryStoreId,
      limit: pageSize,
      depth: query.depth ?? 0,
      pathPrefix,
      ...(position !== undefined && { position }),
    });
    const last = page.items.at(-1);
    return {
      type: "page",
      page: {
        items: page.items.map((item) =>
          item.kind === "prefix"
            ? { kind: "prefix" as const, path: item.path }
            : toView(item.record.memory, projection),
        ),
        nextCursor:
          page.hasMore && last !== undefined ? encodeCursor(last) : null,
      },
    };
  }

  async deleteMemory(command: DeleteMemoryCommand): Promise<DeleteMemoryResult> {
    const current = await this.dependencies.store.findCurrent({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: command.memoryStoreId,
      memoryId: command.memoryId,
    });
    if (current === null) return { type: "not_found" };
    if (
      command.expectedContentSha256 !== undefined &&
      command.expectedContentSha256 !== current.memory.contentSha256
    ) {
      return {
        type: "precondition_failed",
        message: "Memory content SHA-256 precondition failed",
      };
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    const versionId = this.dependencies.ids.nextMemoryVersionId();
    const result = await this.dependencies.store.delete({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: command.memoryStoreId,
      memoryId: command.memoryId,
      expectedRevision: current.revision,
      version: toVersion(
        current.memory,
        versionId,
        "deleted",
        this.dependencies.actor,
        timestamp,
      ),
    });
    if (result.type === "not_found") return { type: "not_found" };
    if (result.type === "revision_conflict") {
      return {
        type: "conflict",
        message: `Memory changed concurrently at revision ${result.actualRevision}`,
      };
    }
    return { type: "deleted", memoryId: command.memoryId };
  }
}
