import type {
  Deployment,
  DeploymentAgent,
  DeploymentAgentSelection,
  DeploymentInitialEvent,
  DeploymentPauseErrorType,
  DeploymentPausedReason,
  DeploymentResource,
  DeploymentSchedule,
} from "../domain/deployment";
import type { RepositoryCheckout } from "../domain/session-resource";
import type { MonetaryAmount } from "../domain/session";
import type { DeploymentRunView } from "./deployment-runs";

export type {
  DeploymentInitialEvent,
  DeploymentPauseErrorType,
  DeploymentPausedReason,
};

type SpendLimit = MonetaryAmount;

export type DeploymentAgentSelector = DeploymentAgentSelection;

export type DeploymentAgentView = DeploymentAgent;

export type DeploymentResourceInput =
  | {
      kind: "file";
      fileId: string;
      mountPath?: string | null;
    }
  | {
      kind: "github_repository";
      authorizationToken: string;
      url: string;
      checkout?: RepositoryCheckout | null;
      mountPath?: string | null;
    }
  | {
      kind: "memory_store";
      memoryStoreId: string;
      access?: "read_write" | "read_only" | null;
      instructions?: string | null;
    };

export type DeploymentResourceView = DeploymentResource;

export interface DeploymentScheduleInput {
  expression: string;
  timezone: string;
}

export type DeploymentScheduleView = DeploymentSchedule;
export type DeploymentView = Deployment;

export interface CreateDeploymentCommand {
  agent: DeploymentAgentSelector;
  environmentId: string;
  initialEvents: DeploymentInitialEvent[];
  name: string;
  budget?: SpendLimit | null;
  description?: string | null;
  metadata?: Record<string, string>;
  resources?: DeploymentResourceInput[];
  schedule?: DeploymentScheduleInput | null;
  vaultIds?: string[];
}

export interface RetrieveDeploymentQuery {
  deploymentId: string;
}

export interface UpdateDeploymentCommand {
  deploymentId: string;
  agent?: DeploymentAgentSelector;
  budget?: SpendLimit | null;
  description?: string | null;
  environmentId?: string;
  initialEvents?: DeploymentInitialEvent[];
  metadata?: Record<string, string | null> | null;
  name?: string;
  resources?: DeploymentResourceInput[] | null;
  schedule?: DeploymentScheduleInput | null;
  vaultIds?: string[] | null;
}

export interface ListDeploymentsQuery {
  pageSize?: number;
  cursor?: string;
  agentId?: string;
  createdAtOrAfter?: string;
  createdAtOrBefore?: string;
  includeArchived?: boolean;
  status?: "active" | "paused";
}

export interface DeploymentsPage {
  deployments: DeploymentView[];
  nextCursor: string | null;
}

export interface DeploymentCommand {
  deploymentId: string;
}

export type CreateDeploymentResult =
  | { type: "created"; deployment: DeploymentView }
  | { type: "invalid_request"; message: string }
  | { type: "dependency_not_found"; message: string };

export type RetrieveDeploymentResult =
  | { type: "found"; deployment: DeploymentView }
  | { type: "not_found" };

export type UpdateDeploymentResult =
  | { type: "updated"; deployment: DeploymentView }
  | { type: "invalid_request"; message: string }
  | { type: "dependency_not_found"; message: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export type ListDeploymentsResult =
  | { type: "page"; page: DeploymentsPage }
  | { type: "invalid_request"; message: string };

export type ChangeDeploymentStateResult =
  | { type: "changed"; deployment: DeploymentView }
  | { type: "not_found" }
  | { type: "conflict"; message: string };

export type RunDeploymentResult =
  | { type: "started"; run: DeploymentRunView }
  | { type: "not_found" }
  | { type: "conflict"; message: string };

export interface DeploymentsApplicationPort {
  createDeployment(command: CreateDeploymentCommand): Promise<CreateDeploymentResult>;
  retrieveDeployment(query: RetrieveDeploymentQuery): Promise<RetrieveDeploymentResult>;
  updateDeployment(command: UpdateDeploymentCommand): Promise<UpdateDeploymentResult>;
  listDeployments(query: ListDeploymentsQuery): Promise<ListDeploymentsResult>;
  archiveDeployment(command: DeploymentCommand): Promise<ChangeDeploymentStateResult>;
  pauseDeployment(command: DeploymentCommand): Promise<ChangeDeploymentStateResult>;
  runDeployment(command: DeploymentCommand): Promise<RunDeploymentResult>;
  unpauseDeployment(command: DeploymentCommand): Promise<ChangeDeploymentStateResult>;
}
