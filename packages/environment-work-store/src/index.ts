import type {
  EnvironmentWork,
  EnvironmentWorkQueueStats,
  EnvironmentWorkSecret,
} from "@open-managed-agents/domain/environment-work";

export type { EnvironmentWorkQueueStats } from "@open-managed-agents/domain/environment-work";

export interface EnvironmentWorkClaim {
  claimedAt: string;
  workerId: string | null;
}

export interface EnvironmentWorkRecord {
  work: EnvironmentWork;
  secret: EnvironmentWorkSecret;
  claim: EnvironmentWorkClaim | null;
  heartbeatTtlSeconds: number;
}

export interface StoredEnvironmentWork extends EnvironmentWorkRecord {
  revision: number;
}

export interface EnvironmentWorkLocation {
  workspaceId: string;
  environmentId: string;
  workId: string;
}

export interface FindActiveEnvironmentSessionWork {
  workspaceId: string;
  sessionId: string;
}

export interface InsertEnvironmentWorkRecord {
  workspaceId: string;
  record: EnvironmentWorkRecord;
}

export interface ReplaceEnvironmentWorkRecord extends EnvironmentWorkLocation {
  expectedRevision: number;
  next: EnvironmentWorkRecord;
}

export type ReplaceEnvironmentWorkRecordResult =
  | { type: "replaced"; record: StoredEnvironmentWork }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface EnvironmentWorkListPosition {
  createdAt: string;
  workId: string;
}

export interface ListEnvironmentWorkRecords {
  workspaceId: string;
  environmentId: string;
  limit: number;
  position?: EnvironmentWorkListPosition;
}

export interface ClaimAvailableEnvironmentWork {
  workspaceId: string;
  environmentId: string;
  claimedAt: string;
  reclaimBefore: string;
  workerId: string | null;
}

export type ClaimAvailableEnvironmentWorkResult =
  | { type: "claimed"; record: StoredEnvironmentWork }
  | { type: "empty" };

export interface GetEnvironmentWorkQueueStatsRecord {
  workspaceId: string;
  environmentId: string;
  workerActiveSince: string;
}

export interface EnvironmentWorkStore {
  insert(input: InsertEnvironmentWorkRecord): Promise<StoredEnvironmentWork>;
  find(input: EnvironmentWorkLocation): Promise<StoredEnvironmentWork | null>;
  findActiveSession(
    input: FindActiveEnvironmentSessionWork,
  ): Promise<StoredEnvironmentWork | null>;
  list(input: ListEnvironmentWorkRecords): Promise<StoredEnvironmentWork[]>;
  replace(
    input: ReplaceEnvironmentWorkRecord,
  ): Promise<ReplaceEnvironmentWorkRecordResult>;
  claimAvailable(
    input: ClaimAvailableEnvironmentWork,
  ): Promise<ClaimAvailableEnvironmentWorkResult>;
  queueStats(
    input: GetEnvironmentWorkQueueStatsRecord,
  ): Promise<EnvironmentWorkQueueStats>;
}
