import type { FileMetadata } from "../domain/file";

export interface FindSessionFileQuery {
  workspaceId: string;
  fileId: string;
}

export interface SessionFileSourcePort {
  find(query: FindSessionFileQuery): Promise<FileMetadata | null>;
}
