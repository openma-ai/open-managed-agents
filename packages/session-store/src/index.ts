import type {
  Session,
  SessionBootstrapEvent,
  SessionStatus,
} from "@open-managed-agents/domain/sessions";

export interface SessionResourceSecret {
  type: "github_token";
  resourceId: string;
  authorizationToken: string;
}

export interface StoredSession {
  session: Session;
  revision: number;
}

export interface InsertSessionRecord {
  workspaceId: string;
  session: Session;
  initialEvents: SessionBootstrapEvent[];
  resourceSecrets: SessionResourceSecret[];
}

export interface FindCurrentSessionRecord {
  workspaceId: string;
  sessionId: string;
}

export interface ReplaceSessionRecord extends FindCurrentSessionRecord {
  expectedRevision: number;
  next: Session;
}

export type ReplaceSessionRecordResult =
  | { type: "replaced"; record: StoredSession }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface ArchiveSessionRecord extends FindCurrentSessionRecord {
  archivedAt: string;
}

export type ArchiveSessionRecordResult =
  | { type: "archived"; record: StoredSession }
  | { type: "not_found" };

export type DeleteSessionRecordResult =
  | { type: "deleted" }
  | { type: "not_found" };

export interface SessionListPosition {
  createdAt: string;
  sessionId: string;
  direction: "next" | "previous";
}

export interface ListSessionRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  order: "asc" | "desc";
  agentId?: string;
  agentVersion?: number;
  createdAfter?: string;
  createdAtOrAfter?: string;
  createdBefore?: string;
  createdAtOrBefore?: string;
  deploymentId?: string;
  memoryStoreId?: string;
  statuses?: SessionStatus[];
  position?: SessionListPosition;
}

export interface SessionStore {
  insert(input: InsertSessionRecord): Promise<StoredSession>;
  findCurrent(input: FindCurrentSessionRecord): Promise<StoredSession | null>;
  replaceCurrent(input: ReplaceSessionRecord): Promise<ReplaceSessionRecordResult>;
  archiveCurrent(input: ArchiveSessionRecord): Promise<ArchiveSessionRecordResult>;
  deleteCurrent(input: FindCurrentSessionRecord): Promise<DeleteSessionRecordResult>;
  listCurrent(input: ListSessionRecords): Promise<StoredSession[]>;
}
