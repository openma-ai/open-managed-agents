import type { MemoryStore } from "@open-managed-agents/domain/memory-stores";
import type { MemoryStoreStore } from "@open-managed-agents/memory-store-store";
import type {
  ArchiveMemoryStoreCommand,
  ArchiveMemoryStoreResult,
  CreateMemoryStoreCommand,
  CreateMemoryStoreResult,
  DeleteMemoryStoreCommand,
  DeleteMemoryStoreResult,
  ListMemoryStoresQuery,
  ListMemoryStoresResult,
  MemoryStoresApplicationPort,
  RetrieveMemoryStoreQuery,
  RetrieveMemoryStoreResult,
  UpdateMemoryStoreCommand,
  UpdateMemoryStoreResult,
} from "../ports/memory-stores";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

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

function encodeMemoryStoreCursor(memoryStore: MemoryStore): string {
  return `memory-stores.${encodeCursorPart(memoryStore.createdAt)}.${encodeCursorPart(memoryStore.id)}`;
}

function decodeMemoryStoreCursor(
  value: string,
): { createdAt: string; memoryStoreId: string } | null {
  const [scope, createdAt, memoryStoreId, extra] = value.split(".");
  if (
    scope !== "memory-stores" ||
    createdAt === undefined ||
    memoryStoreId === undefined ||
    extra !== undefined
  ) return null;
  const decodedCreatedAt = decodeCursorPart(createdAt);
  const decodedMemoryStoreId = decodeCursorPart(memoryStoreId);
  if (
    decodedCreatedAt === null ||
    decodedMemoryStoreId === null ||
    decodedMemoryStoreId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return {
    createdAt: decodedCreatedAt,
    memoryStoreId: decodedMemoryStoreId,
  };
}

function validateMetadata(
  metadata: Record<string, string>,
): string | null {
  const entries = Object.entries(metadata);
  if (entries.length > 16) {
    return "Memory store metadata may contain at most 16 keys";
  }
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > 64) {
      return "Memory store metadata keys must contain 1 to 64 characters";
    }
    if (value.length > 512) {
      return "Memory store metadata values may contain at most 512 characters";
    }
  }
  return null;
}

function validateName(name: string): string | null {
  if (name.length < 1 || name.length > 255) {
    return "Memory store name must contain 1 to 255 characters";
  }
  if (/\p{Cc}/u.test(name)) {
    return "Memory store name must not contain control characters";
  }
  return null;
}

function patchMetadata(
  current: Record<string, string> | undefined,
  patch: Record<string, string | null> | null,
): Record<string, string> | undefined {
  if (patch === null) return undefined;
  const next = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

export interface MemoryStoresApplicationServiceDependencies {
  workspaceId: string;
  store: MemoryStoreStore;
  clock: { now(): Date };
  ids: { nextMemoryStoreId(): string };
}

export class MemoryStoresApplicationService
  implements MemoryStoresApplicationPort
{
  constructor(
    private readonly dependencies: MemoryStoresApplicationServiceDependencies,
  ) {}

  async createMemoryStore(
    command: CreateMemoryStoreCommand,
  ): Promise<CreateMemoryStoreResult> {
    const invalidName = validateName(command.name);
    if (invalidName !== null) {
      return { type: "invalid_request", message: invalidName };
    }
    if (command.description !== undefined && command.description.length > 1024) {
      return {
        type: "invalid_request",
        message: "Memory store description may contain at most 1024 characters",
      };
    }
    if (command.metadata !== undefined) {
      const invalidMetadata = validateMetadata(command.metadata);
      if (invalidMetadata !== null) {
        return { type: "invalid_request", message: invalidMetadata };
      }
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    const memoryStore: MemoryStore = {
      id: this.dependencies.ids.nextMemoryStoreId(),
      createdAt: timestamp,
      name: command.name,
      updatedAt: timestamp,
      archivedAt: null,
      ...(command.description !== undefined && command.description.length > 0 && {
        description: command.description,
      }),
      ...(command.metadata !== undefined &&
        Object.keys(command.metadata).length > 0 && { metadata: command.metadata }),
    };
    const record = await this.dependencies.store.insert({
      workspaceId: this.dependencies.workspaceId,
      memoryStore,
    });
    return { type: "created", memoryStore: record.memoryStore };
  }

  async retrieveMemoryStore(
    query: RetrieveMemoryStoreQuery,
  ): Promise<RetrieveMemoryStoreResult> {
    const record = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: query.memoryStoreId,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", memoryStore: record.memoryStore };
  }

  async updateMemoryStore(
    command: UpdateMemoryStoreCommand,
  ): Promise<UpdateMemoryStoreResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: command.memoryStoreId,
    });
    if (current === null) return { type: "not_found" };
    if (command.name !== undefined && command.name !== null) {
      const invalidName = validateName(command.name);
      if (invalidName !== null) {
        return { type: "invalid_request", message: invalidName };
      }
    }
    if (
      command.description !== undefined &&
      command.description !== null &&
      command.description.length > 1024
    ) {
      return {
        type: "invalid_request",
        message: "Memory store description may contain at most 1024 characters",
      };
    }
    const metadata =
      command.metadata === undefined
        ? current.memoryStore.metadata
        : patchMetadata(current.memoryStore.metadata, command.metadata);
    if (metadata !== undefined) {
      const invalidMetadata = validateMetadata(metadata);
      if (invalidMetadata !== null) {
        return { type: "invalid_request", message: invalidMetadata };
      }
    }
    const next: MemoryStore = {
      ...current.memoryStore,
      ...(command.name !== undefined && command.name !== null && {
        name: command.name,
      }),
      updatedAt: this.dependencies.clock.now().toISOString(),
    };
    if (command.description !== undefined) {
      if (command.description === null || command.description.length === 0) {
        delete next.description;
      } else {
        next.description = command.description;
      }
    }
    if (metadata === undefined) delete next.metadata;
    else next.metadata = metadata;
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: command.memoryStoreId,
      expectedRevision: current.revision,
      next,
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Memory store changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "updated", memoryStore: replaced.record.memoryStore };
  }

  async listMemoryStores(
    query: ListMemoryStoresQuery,
  ): Promise<ListMemoryStoresResult> {
    const position =
      query.cursor === undefined
        ? undefined
        : decodeMemoryStoreCursor(query.cursor);
    if (position === null) {
      return {
        type: "invalid_request",
        message: "Invalid memory stores page cursor",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      limit: pageSize + 1,
      includeArchived: query.includeArchived ?? false,
      ...(query.createdAtOrAfter !== undefined && {
        createdAtOrAfter: query.createdAtOrAfter,
      }),
      ...(query.createdAtOrBefore !== undefined && {
        createdAtOrBefore: query.createdAtOrBefore,
      }),
      ...(position !== undefined && { position }),
    });
    const hasMore = records.length > pageSize;
    const selected = hasMore ? records.slice(0, pageSize) : records;
    const memoryStores = selected.map((record) => record.memoryStore);
    const last = memoryStores[memoryStores.length - 1];
    return {
      type: "page",
      page: {
        memoryStores,
        nextCursor:
          hasMore && last !== undefined ? encodeMemoryStoreCursor(last) : null,
      },
    };
  }

  async deleteMemoryStore(
    command: DeleteMemoryStoreCommand,
  ): Promise<DeleteMemoryStoreResult> {
    const result = await this.dependencies.store.delete({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: command.memoryStoreId,
    });
    return result.type === "not_found"
      ? { type: "not_found" }
      : { type: "deleted", memoryStoreId: command.memoryStoreId };
  }

  async archiveMemoryStore(
    command: ArchiveMemoryStoreCommand,
  ): Promise<ArchiveMemoryStoreResult> {
    const result = await this.dependencies.store.archive({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: command.memoryStoreId,
      archivedAt: this.dependencies.clock.now().toISOString(),
    });
    return result.type === "not_found"
      ? { type: "not_found" }
      : { type: "archived", memoryStore: result.record.memoryStore };
  }
}
