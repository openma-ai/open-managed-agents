export interface SkillUploadFileInput {
  filename: string;
  mimeType: string;
  content: Uint8Array;
}

export interface SkillView {
  id: string;
  createdAt: string;
  displayTitle: string | null;
  latestVersion: string | null;
  source: string;
  updatedAt: string;
}

export interface CreateSkillCommand {
  files: SkillUploadFileInput[];
  displayTitle?: string | null;
}

export interface RetrieveSkillQuery {
  skillId: string;
}

export interface ListSkillsQuery {
  pageSize?: number;
  cursor?: string;
  source?: string | null;
}

export interface SkillsPage {
  skills: SkillView[];
  nextCursor: string | null;
}

export interface DeleteSkillCommand {
  skillId: string;
}

export type CreateSkillResult =
  | { type: "created"; skill: SkillView }
  | { type: "invalid_request"; message: string };

export type RetrieveSkillResult =
  | { type: "found"; skill: SkillView }
  | { type: "not_found" };

export type ListSkillsResult =
  | { type: "page"; page: SkillsPage }
  | { type: "invalid_request"; message: string };

export type DeleteSkillResult =
  | { type: "deleted"; skillId: string }
  | { type: "not_found" };

export interface SkillsApplicationPort {
  createSkill(command: CreateSkillCommand): Promise<CreateSkillResult>;
  retrieveSkill(query: RetrieveSkillQuery): Promise<RetrieveSkillResult>;
  listSkills(query: ListSkillsQuery): Promise<ListSkillsResult>;
  deleteSkill(command: DeleteSkillCommand): Promise<DeleteSkillResult>;
}
