import type { FileMetadata } from "../domain/file.js";

export interface FindDeploymentFile {
  workspaceId: string;
  fileId: string;
}

export interface DeploymentFileSourcePort {
  find(input: FindDeploymentFile): Promise<FileMetadata | null>;
}
