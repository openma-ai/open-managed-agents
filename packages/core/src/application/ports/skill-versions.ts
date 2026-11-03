export interface SkillVersionUploadFileInput {
  filename: string;
  mimeType: string;
  content: Uint8Array;
}

export interface SkillVersionView {
  id: string;
  createdAt: string;
  description: string;
  directory: string;
  name: string;
  skillId: string;
  version: string;
}

export interface CreateSkillVersionCommand {
  skillId: string;
  files: SkillVersionUploadFileInput[];
}

export interface RetrieveSkillVersionQuery {
  skillId: string;
  version: string;
}

export interface ListSkillVersionsQuery {
  skillId: string;
  pageSize?: number;
  cursor?: string;
}

export interface SkillVersionsPage {
  versions: SkillVersionView[];
  nextCursor: string | null;
}

export interface DeleteSkillVersionCommand {
  skillId: string;
  version: string;
}

export interface DownloadSkillVersionQuery {
  skillId: string;
  version: string;
}

export interface DownloadedSkillVersionView {
  content: Uint8Array;
  mimeType: string;
  filename?: string;
}

export type CreateSkillVersionResult =
  | { type: "created"; version: SkillVersionView }
  | { type: "invalid_request"; message: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export type RetrieveSkillVersionResult =
  | { type: "found"; version: SkillVersionView }
  | { type: "not_found" };

export type ListSkillVersionsResult =
  | { type: "page"; page: SkillVersionsPage }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export type DeleteSkillVersionResult =
  | { type: "deleted"; version: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export type DownloadSkillVersionResult =
  | { type: "found"; file: DownloadedSkillVersionView }
  | { type: "not_found" };

export interface SkillVersionsApplicationPort {
  createSkillVersion(command: CreateSkillVersionCommand): Promise<CreateSkillVersionResult>;
  retrieveSkillVersion(query: RetrieveSkillVersionQuery): Promise<RetrieveSkillVersionResult>;
  listSkillVersions(query: ListSkillVersionsQuery): Promise<ListSkillVersionsResult>;
  deleteSkillVersion(command: DeleteSkillVersionCommand): Promise<DeleteSkillVersionResult>;
  downloadSkillVersion(query: DownloadSkillVersionQuery): Promise<DownloadSkillVersionResult>;
}
