export interface Memory {
  id: string;
  content: string | null;
  contentSha256: string;
  contentSizeBytes: number;
  createdAt: string;
  memoryStoreId: string;
  memoryVersionId: string;
  path: string;
  updatedAt: string;
}

export type MemoryVersionActor =
  | { kind: "api"; apiKeyId: string }
  | { kind: "service_account"; serviceAccountId: string }
  | { kind: "session"; sessionId: string }
  | { kind: "user"; userId: string };

export interface MemoryVersion {
  id: string;
  content: string | null;
  contentSha256: string | null;
  contentSizeBytes: number | null;
  createdAt: string;
  createdBy: MemoryVersionActor;
  memoryId: string;
  memoryStoreId: string;
  operation: "created" | "modified" | "deleted";
  path: string | null;
  redactedAt: string | null;
  redactedBy?: MemoryVersionActor;
}
