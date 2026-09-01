import type {
  Deployment,
  DeploymentResourceSecret,
} from "@open-managed-agents/domain/deployments";

export interface DeploymentRecord {
  deployment: Deployment;
  resourceSecrets: DeploymentResourceSecret[];
}

export interface StoredDeployment extends DeploymentRecord {
  revision: number;
}

export interface DeploymentLocation {
  workspaceId: string;
  deploymentId: string;
}

export interface InsertDeploymentRecord {
  workspaceId: string;
  record: DeploymentRecord;
}

export interface ReplaceDeploymentRecord extends DeploymentLocation {
  expectedRevision: number;
  next: DeploymentRecord;
}

export type ReplaceDeploymentRecordResult =
  | { type: "replaced"; record: StoredDeployment }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface DeploymentListPosition {
  createdAt: string;
  deploymentId: string;
}

export interface ListDeploymentRecords {
  workspaceId: string;
  limit: number;
  includeArchived: boolean;
  agentId?: string;
  createdAtOrAfter?: string;
  createdAtOrBefore?: string;
  status?: "active" | "paused";
  position?: DeploymentListPosition;
}

export interface DeploymentStore {
  insert(input: InsertDeploymentRecord): Promise<StoredDeployment>;
  find(input: DeploymentLocation): Promise<StoredDeployment | null>;
  replace(input: ReplaceDeploymentRecord): Promise<ReplaceDeploymentRecordResult>;
  list(input: ListDeploymentRecords): Promise<StoredDeployment[]>;
}
