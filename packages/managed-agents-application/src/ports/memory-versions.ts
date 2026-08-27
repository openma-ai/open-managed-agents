import type { MemoryProjection } from "./memories";

export type MemoryVersionActorView =
  | { kind: "api"; apiKeyId: string }
  | { kind: "service_account"; serviceAccountId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "user"; userId: string };

export interface MemoryVersionView {
  id: string;
  createdAt: string;
  memoryId: string;
  memoryStoreId: string;
  operation: "created" | "modified" | "deleted";
  content?: string | null;
  contentSha256?: string | null;
  contentSizeBytes?: number | null;
  createdBy?: MemoryVersionActorView;
  path?: string | null;
  redactedAt?: string | null;
  redactedBy?: MemoryVersionActorView;
}

export interface RetrieveMemoryVersionQuery {
  memoryStoreId: string;
  memoryVersionId: string;
  projection?: MemoryProjection;
}

export interface ListMemoryVersionsQuery {
  memoryStoreId: string;
  pageSize?: number;
  cursor?: string;
  apiKeyId?: string;
  createdAtOrAfter?: string;
  createdAtOrBefore?: string;
  memoryId?: string;
  operation?: "created" | "modified" | "deleted";
  serviceAccountId?: string;
  sessionId?: string;
  projection?: MemoryProjection;
}

export interface MemoryVersionsPage {
  versions: MemoryVersionView[];
  nextCursor: string | null;
}

export interface RedactMemoryVersionCommand {
  memoryStoreId: string;
  memoryVersionId: string;
}

export type RetrieveMemoryVersionResult =
  | { type: "found"; version: MemoryVersionView }
  | { type: "not_found" };

export type ListMemoryVersionsResult =
  | { type: "page"; page: MemoryVersionsPage }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export type RedactMemoryVersionResult =
  | { type: "redacted"; version: MemoryVersionView }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export interface MemoryVersionsApplicationPort {
  retrieveMemoryVersion(query: RetrieveMemoryVersionQuery): Promise<RetrieveMemoryVersionResult>;
  listMemoryVersions(query: ListMemoryVersionsQuery): Promise<ListMemoryVersionsResult>;
  redactMemoryVersion(command: RedactMemoryVersionCommand): Promise<RedactMemoryVersionResult>;
}
