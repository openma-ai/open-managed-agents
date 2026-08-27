import type {
  Dream,
  DreamInput,
  DreamOutputBehavior,
  DreamStatus,
} from "../domain/dream";

export type {
  Dream,
  DreamError,
  DreamInput,
  DreamModel,
  DreamOutput,
  DreamOutputBehavior,
  DreamStatus,
  DreamUsage,
} from "../domain/dream";

export interface DreamModelInput {
  modelId: string;
  speed?: "standard" | "fast" | null;
}

export interface CreateDreamCommand {
  inputs: DreamInput[];
  model: DreamModelInput;
  instructions?: string | null;
  outputBehavior?: DreamOutputBehavior;
}

export interface RetrieveDreamQuery {
  dreamId: string;
}

export interface ListDreamsQuery {
  pageSize?: number;
  cursor?: string;
  createdAfter?: string;
  createdBefore?: string;
  includeArchived?: boolean;
  statuses?: DreamStatus[];
}

export interface DreamsPage {
  dreams: Dream[];
  nextCursor: string | null;
}

export interface DreamCommand {
  dreamId: string;
}

export type CreateDreamResult =
  | { type: "created"; dream: Dream }
  | { type: "invalid_request"; message: string }
  | { type: "dependency_not_found"; message: string };

export type RetrieveDreamResult =
  | { type: "found"; dream: Dream }
  | { type: "not_found" };

export type ListDreamsResult =
  | { type: "page"; page: DreamsPage }
  | { type: "invalid_request"; message: string };

export type ChangeDreamStateResult =
  | { type: "changed"; dream: Dream }
  | { type: "not_found" }
  | { type: "conflict"; message: string };

export interface DreamsApplicationPort {
  createDream(command: CreateDreamCommand): Promise<CreateDreamResult>;
  retrieveDream(query: RetrieveDreamQuery): Promise<RetrieveDreamResult>;
  listDreams(query: ListDreamsQuery): Promise<ListDreamsResult>;
  archiveDream(command: DreamCommand): Promise<ChangeDreamStateResult>;
  cancelDream(command: DreamCommand): Promise<ChangeDreamStateResult>;
}
