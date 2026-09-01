import type { Agent } from "@open-managed-agents/domain/agents";

export type AgentRecord = Agent;

export interface InsertAgentRecord {
  workspaceId: string;
  agent: AgentRecord;
}

export interface ReplaceAgentRecord {
  workspaceId: string;
  agentId: string;
  expectedVersion: number;
  next: AgentRecord;
}

export interface FindCurrentAgentRecord {
  workspaceId: string;
  agentId: string;
}

export interface FindAgentVersionRecord extends FindCurrentAgentRecord {
  version: number;
}

export type ReplaceAgentRecordResult =
  | { type: "replaced"; agent: AgentRecord }
  | { type: "not_found" }
  | { type: "version_conflict"; actualVersion: number };

export interface ArchiveAgentRecord {
  workspaceId: string;
  agentId: string;
  archivedAt: string;
}

export type ArchiveAgentRecordResult =
  | { type: "archived"; agent: AgentRecord }
  | { type: "not_found" };

export interface AgentListPosition {
  createdAt: string;
  agentId: string;
}

export interface ListAgentRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  createdAtOrAfter?: string;
  createdAtOrBefore?: string;
  after?: AgentListPosition;
}

export interface ListAgentVersionRecords {
  workspaceId: string;
  agentId: string;
  beforeVersion: number;
  limit: number;
}

export interface AgentStore {
  insert(input: InsertAgentRecord): Promise<AgentRecord>;
  findCurrent(input: FindCurrentAgentRecord): Promise<AgentRecord | null>;
  findVersion(input: FindAgentVersionRecord): Promise<AgentRecord | null>;
  replaceCurrent(input: ReplaceAgentRecord): Promise<ReplaceAgentRecordResult>;
  archiveCurrent(input: ArchiveAgentRecord): Promise<ArchiveAgentRecordResult>;
  listCurrent(input: ListAgentRecords): Promise<AgentRecord[]>;
  listVersions(input: ListAgentVersionRecords): Promise<AgentRecord[]>;
}
