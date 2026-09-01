import type {
  EnvironmentWork,
  EnvironmentWorkHeartbeat,
  EnvironmentWorkQueueStats,
  EnvironmentWorkSecret,
} from "../domain/environment-work";

export type * from "../domain/environment-work";

export type EnvironmentWorkView = EnvironmentWork & {
  secret: EnvironmentWorkSecret | null;
};

export interface RetrieveEnvironmentWorkQuery {
  environmentId: string;
  workId: string;
}

export interface UpdateEnvironmentWorkCommand {
  environmentId: string;
  workId: string;
  metadata: Record<string, string | null>;
}

export interface ListEnvironmentWorkQuery {
  environmentId: string;
  pageSize?: number;
  cursor?: string;
}

export interface EnvironmentWorkPage {
  workItems: EnvironmentWorkView[];
  nextCursor: string | null;
}

export interface AcknowledgeEnvironmentWorkCommand {
  environmentId: string;
  workId: string;
}

export interface HeartbeatEnvironmentWorkCommand {
  environmentId: string;
  workId: string;
  desiredTtlSeconds?: number | null;
  expectedLastHeartbeat?: string | null;
}

export type EnvironmentWorkHeartbeatView = EnvironmentWorkHeartbeat;

export interface PollEnvironmentWorkQuery {
  environmentId: string;
  blockMilliseconds?: number | null;
  reclaimOlderThanMilliseconds?: number | null;
  workerId?: string;
}

export interface GetEnvironmentWorkQueueStatsQuery {
  environmentId: string;
}

export type EnvironmentWorkQueueStatsView = EnvironmentWorkQueueStats;

export interface StopEnvironmentWorkCommand {
  environmentId: string;
  workId: string;
  force?: boolean;
}

export type EnvironmentWorkResult =
  | { type: "found"; work: EnvironmentWorkView }
  | { type: "not_found" };

export type UpdateEnvironmentWorkResult =
  | { type: "updated"; work: EnvironmentWorkView }
  | { type: "invalid_request"; message: string }
  | { type: "conflict"; message: string }
  | { type: "not_found" };

export type ListEnvironmentWorkResult =
  | { type: "page"; page: EnvironmentWorkPage }
  | { type: "invalid_request"; message: string }
  | { type: "not_found" };

export type AcknowledgeEnvironmentWorkResult =
  | { type: "acknowledged"; work: EnvironmentWorkView }
  | { type: "conflict"; message: string }
  | { type: "not_found" };

export type HeartbeatEnvironmentWorkResult =
  | { type: "recorded"; heartbeat: EnvironmentWorkHeartbeatView }
  | { type: "precondition_failed"; message: string }
  | { type: "not_found" };

export type PollEnvironmentWorkResult =
  | { type: "work"; work: EnvironmentWorkView }
  | { type: "empty" }
  | { type: "not_found" };

export type GetEnvironmentWorkQueueStatsResult =
  | { type: "found"; stats: EnvironmentWorkQueueStatsView }
  | { type: "not_found" };

export type StopEnvironmentWorkResult =
  | { type: "stopped"; work: EnvironmentWorkView }
  | { type: "conflict"; message: string }
  | { type: "not_found" };

export interface EnvironmentWorkApplicationPort {
  retrieveEnvironmentWork(query: RetrieveEnvironmentWorkQuery): Promise<EnvironmentWorkResult>;
  updateEnvironmentWork(command: UpdateEnvironmentWorkCommand): Promise<UpdateEnvironmentWorkResult>;
  listEnvironmentWork(query: ListEnvironmentWorkQuery): Promise<ListEnvironmentWorkResult>;
  acknowledgeEnvironmentWork(command: AcknowledgeEnvironmentWorkCommand): Promise<AcknowledgeEnvironmentWorkResult>;
  heartbeatEnvironmentWork(command: HeartbeatEnvironmentWorkCommand): Promise<HeartbeatEnvironmentWorkResult>;
  pollEnvironmentWork(query: PollEnvironmentWorkQuery): Promise<PollEnvironmentWorkResult>;
  getEnvironmentWorkQueueStats(query: GetEnvironmentWorkQueueStatsQuery): Promise<GetEnvironmentWorkQueueStatsResult>;
  stopEnvironmentWork(command: StopEnvironmentWorkCommand): Promise<StopEnvironmentWorkResult>;
}
