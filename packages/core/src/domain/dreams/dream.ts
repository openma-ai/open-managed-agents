export type DreamStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type DreamInput =
  | { kind: "memory_store"; memoryStoreId: string }
  | { kind: "sessions"; sessionIds: string[] };

export interface DreamModel {
  modelId: string;
  speed?: "standard" | "fast";
}

export type DreamOutputBehavior =
  | { kind: "create_new" }
  | { kind: "update_existing"; memoryStoreId: string };

export interface DreamOutput {
  kind: "memory_store";
  memoryStoreId: string;
}

export interface DreamUsage {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DreamError {
  type: string;
  message: string;
}

export interface Dream {
  id: string;
  archivedAt: string | null;
  createdAt: string;
  endedAt: string | null;
  error: DreamError | null;
  inputs: DreamInput[];
  instructions: string | null;
  model: DreamModel;
  outputBehavior: DreamOutputBehavior;
  outputs: DreamOutput[];
  sessionId: string | null;
  status: DreamStatus;
  usage: DreamUsage;
}
