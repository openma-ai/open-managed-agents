import type {
  DeploymentRun,
  DeploymentRunErrorType,
  DeploymentRunTriggerContext,
} from "../domain/deployment-run";

export type { DeploymentRunErrorType, DeploymentRunTriggerContext };

export interface DeploymentRunAgentView {
  id: string;
  version: number;
}

export type DeploymentRunView = DeploymentRun;

export interface RetrieveDeploymentRunQuery {
  deploymentRunId: string;
}

export interface ListDeploymentRunsQuery {
  pageSize?: number;
  cursor?: string;
  createdAfter?: string;
  createdAtOrAfter?: string;
  createdBefore?: string;
  createdAtOrBefore?: string;
  deploymentId?: string;
  hasError?: boolean;
  triggerType?: "schedule" | "manual";
}

export interface DeploymentRunsPage {
  runs: DeploymentRunView[];
  nextCursor: string | null;
}

export type RetrieveDeploymentRunResult =
  | { type: "found"; run: DeploymentRunView }
  | { type: "not_found" };

export type ListDeploymentRunsResult =
  | { type: "page"; page: DeploymentRunsPage }
  | { type: "invalid_request"; message: string };

export interface DeploymentRunsApplicationPort {
  retrieveDeploymentRun(query: RetrieveDeploymentRunQuery): Promise<RetrieveDeploymentRunResult>;
  listDeploymentRuns(query: ListDeploymentRunsQuery): Promise<ListDeploymentRunsResult>;
}
