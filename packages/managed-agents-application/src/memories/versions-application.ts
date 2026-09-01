import type {
  MemoryVersion,
  MemoryVersionActor,
} from "@open-managed-agents/domain/memories";
import type {
  MemoryDocumentStore,
  MemoryVersionListPosition,
} from "@open-managed-agents/memory-document-store";
import type { MemoryProjection } from "../ports/memories";
import type {
  ListMemoryVersionsQuery,
  ListMemoryVersionsResult,
  MemoryVersionView,
  MemoryVersionsApplicationPort,
  RedactMemoryVersionCommand,
  RedactMemoryVersionResult,
  RetrieveMemoryVersionQuery,
  RetrieveMemoryVersionResult,
} from "../ports/memory-versions";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_FULL_PAGE_SIZE = 20;

function encodePart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodePart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodePart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeCursor(version: MemoryVersion): string {
  return `memory_versions.${encodePart(version.createdAt)}.${encodePart(version.id)}`;
}

function decodeCursor(value: string): MemoryVersionListPosition | null {
  const [scope, createdAt, memoryVersionId, extra] = value.split(".");
  if (
    scope !== "memory_versions" ||
    createdAt === undefined ||
    memoryVersionId === undefined ||
    extra !== undefined
  ) return null;
  const decodedCreatedAt = decodePart(createdAt);
  const decodedId = decodePart(memoryVersionId);
  if (
    decodedCreatedAt === null ||
    decodedId === null ||
    decodedId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return { createdAt: decodedCreatedAt, memoryVersionId: decodedId };
}

function toView(
  version: MemoryVersion,
  projection: MemoryProjection,
): MemoryVersionView {
  return {
    id: version.id,
    createdAt: version.createdAt,
    memoryId: version.memoryId,
    memoryStoreId: version.memoryStoreId,
    operation: version.operation,
    content: projection === "full" ? version.content : null,
    contentSha256: version.contentSha256,
    contentSizeBytes: version.contentSizeBytes,
    createdBy: version.createdBy,
    path: version.path,
    redactedAt: version.redactedAt,
    ...(version.redactedBy !== undefined && {
      redactedBy: version.redactedBy,
    }),
  };
}

export interface MemoryVersionsApplicationServiceDependencies {
  workspaceId: string;
  store: MemoryDocumentStore;
  actor: MemoryVersionActor;
  clock: { now(): Date };
}

export class MemoryVersionsApplicationService
  implements MemoryVersionsApplicationPort
{
  constructor(
    private readonly dependencies: MemoryVersionsApplicationServiceDependencies,
  ) {}

  async retrieveMemoryVersion(
    query: RetrieveMemoryVersionQuery,
  ): Promise<RetrieveMemoryVersionResult> {
    const record = await this.dependencies.store.findVersion({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: query.memoryStoreId,
      memoryVersionId: query.memoryVersionId,
    });
    return record === null
      ? { type: "not_found" }
      : {
          type: "found",
          version: toView(record.version, query.projection ?? "full"),
        };
  }

  async listMemoryVersions(
    query: ListMemoryVersionsQuery,
  ): Promise<ListMemoryVersionsResult> {
    const position =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (position === null) {
      return {
        type: "invalid_request",
        message: "Invalid memory version page cursor",
      };
    }
    const projection = query.projection ?? "basic";
    const maximum = projection === "full" ? MAX_FULL_PAGE_SIZE : MAX_PAGE_SIZE;
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      maximum,
    );
    const records = await this.dependencies.store.listVersions({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: query.memoryStoreId,
      limit: pageSize + 1,
      ...(query.apiKeyId !== undefined && { apiKeyId: query.apiKeyId }),
      ...(query.createdAtOrAfter !== undefined && {
        createdAtOrAfter: query.createdAtOrAfter,
      }),
      ...(query.createdAtOrBefore !== undefined && {
        createdAtOrBefore: query.createdAtOrBefore,
      }),
      ...(query.memoryId !== undefined && { memoryId: query.memoryId }),
      ...(query.operation !== undefined && { operation: query.operation }),
      ...(query.serviceAccountId !== undefined && {
        serviceAccountId: query.serviceAccountId,
      }),
      ...(query.sessionId !== undefined && { sessionId: query.sessionId }),
      ...(position !== undefined && { position }),
    });
    const hasMore = records.length > pageSize;
    const pageRecords = hasMore ? records.slice(0, pageSize) : records;
    const last = pageRecords.at(-1);
    return {
      type: "page",
      page: {
        versions: pageRecords.map((record) =>
          toView(record.version, projection),
        ),
        nextCursor:
          hasMore && last !== undefined ? encodeCursor(last.version) : null,
      },
    };
  }

  async redactMemoryVersion(
    command: RedactMemoryVersionCommand,
  ): Promise<RedactMemoryVersionResult> {
    const current = await this.dependencies.store.findVersion({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: command.memoryStoreId,
      memoryVersionId: command.memoryVersionId,
    });
    if (current === null) return { type: "not_found" };
    const result = await this.dependencies.store.redactVersion({
      workspaceId: this.dependencies.workspaceId,
      memoryStoreId: command.memoryStoreId,
      memoryVersionId: command.memoryVersionId,
      expectedRevision: current.revision,
      redactedAt: this.dependencies.clock.now().toISOString(),
      redactedBy: this.dependencies.actor,
    });
    if (result.type === "not_found") return { type: "not_found" };
    if (result.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Memory version changed concurrently at revision ${result.actualRevision}`,
      };
    }
    return {
      type: "redacted",
      version: toView(result.record.version, "full"),
    };
  }
}
