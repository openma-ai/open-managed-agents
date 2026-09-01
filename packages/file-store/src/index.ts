import type { FileMetadata } from "@open-managed-agents/domain/files";

export type FileRecord = FileMetadata;

export interface InsertFileRecord {
  workspaceId: string;
  file: FileRecord;
}

export interface FileLocation {
  workspaceId: string;
  fileId: string;
}

export interface FileListPosition {
  fileId: string;
  direction: "before" | "after";
}

export interface ListFileRecords {
  workspaceId: string;
  limit: number;
  scopeId?: string;
  position?: FileListPosition;
}

export type DeleteFileRecordResult =
  | { type: "deleted" }
  | { type: "not_found" };

export interface FileStore {
  insert(input: InsertFileRecord): Promise<FileRecord>;
  find(input: FileLocation): Promise<FileRecord | null>;
  list(input: ListFileRecords): Promise<FileRecord[]>;
  delete(input: FileLocation): Promise<DeleteFileRecordResult>;
}
