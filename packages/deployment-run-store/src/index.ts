import type { DeploymentRun } from "@open-managed-agents/domain/deployments";

export interface StoredDeploymentRun {
  run: DeploymentRun;
  revision: number;
}

export interface DeploymentRunLocation {
  workspaceId: string;
  deploymentRunId: string;
}

export interface BeginManualDeploymentRun {
  workspaceId: string;
  deploymentId: string;
  expectedDeploymentRevision: number;
  run: DeploymentRun;
}

export type BeginManualDeploymentRunResult =
  | { type: "began"; record: StoredDeploymentRun }
  | { type: "not_found" }
  | { type: "deployment_revision_conflict"; actualRevision: number }
  | { type: "not_runnable" };

export interface FinalizeDeploymentRun extends DeploymentRunLocation {
  expectedRevision: number;
  next: DeploymentRun;
}

export type FinalizeDeploymentRunResult =
  | { type: "finalized"; record: StoredDeploymentRun }
  | { type: "not_found" }
  | { type: "revision_conflict"; actualRevision: number };

export interface DeploymentRunListPosition {
  createdAt: string;
  deploymentRunId: string;
}

export interface ListDeploymentRunRecords {
  workspaceId: string;
  limit: number;
  createdAfter?: string;
  createdAtOrAfter?: string;
  createdBefore?: string;
  createdAtOrBefore?: string;
  deploymentId?: string;
  hasError?: boolean;
  triggerType?: "schedule" | "manual";
  position?: DeploymentRunListPosition;
}

/**
 * Owns Deployment Run records and the atomic admission of a manual Run
 * against an exact active Deployment revision.
 */
export interface DeploymentRunStore {
  beginManual(
    input: BeginManualDeploymentRun,
  ): Promise<BeginManualDeploymentRunResult>;
  finalize(input: FinalizeDeploymentRun): Promise<FinalizeDeploymentRunResult>;
  find(input: DeploymentRunLocation): Promise<StoredDeploymentRun | null>;
  list(input: ListDeploymentRunRecords): Promise<StoredDeploymentRun[]>;
}
