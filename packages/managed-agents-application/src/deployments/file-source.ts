import type { FileMetadata } from "../domain/file";

export interface FindDeploymentFile {
  workspaceId: string;
  fileId: string;
}

export interface DeploymentFileSourcePort {
  find(input: FindDeploymentFile): Promise<FileMetadata | null>;
}
