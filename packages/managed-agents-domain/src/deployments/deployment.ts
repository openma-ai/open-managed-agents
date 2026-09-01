import type {
  MonetaryAmount,
  RepositoryCheckout,
  SessionBootstrapContent,
  SessionBootstrapEvent,
} from "../sessions";

export type DeploymentUserMessageContent = SessionBootstrapContent;
export type DeploymentInitialEvent = SessionBootstrapEvent;

export interface DeploymentAgent {
  id: string;
  version: number;
}

export type DeploymentAgentSelection =
  | { kind: "latest"; agentId: string }
  | { kind: "versioned"; agentId: string; version: number };

export type DeploymentResource =
  | {
      kind: "file";
      fileId: string;
      mountPath?: string | null;
    }
  | {
      kind: "github_repository";
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

export interface DeploymentSchedule {
  expression: string;
  timezone: string;
  lastRunAt?: string | null;
  upcomingRunsAt?: string[];
}

export type DeploymentPauseErrorType =
  | "agent_archived_error"
  | "environment_archived_error"
  | "environment_not_found_error"
  | "vault_not_found_error"
  | "file_not_found_error"
  | "session_resource_not_found_error"
  | "workspace_archived_error"
  | "organization_disabled_error"
  | "memory_store_archived_error"
  | "skill_not_found_error"
  | "vault_archived_error"
  | "unknown_error"
  | "self_hosted_resources_unsupported_error"
  | "mcp_egress_blocked_error";

export type DeploymentPausedReason =
  | { kind: "manual" }
  | { kind: "error"; errorType: DeploymentPauseErrorType };

export interface Deployment {
  id: string;
  agent: DeploymentAgent;
  archivedAt: string | null;
  createdAt: string;
  description: string | null;
  environmentId: string;
  initialEvents: DeploymentInitialEvent[];
  metadata: Record<string, string>;
  name: string;
  pausedReason: DeploymentPausedReason | null;
  resources: DeploymentResource[];
  schedule: DeploymentSchedule | null;
  status: "active" | "paused";
  updatedAt: string;
  vaultIds: string[];
  budget?: MonetaryAmount | null;
}

export interface DeploymentResourceSecret {
  kind: "github_repository_token";
  resourceIndex: number;
  authorizationToken: string;
}
