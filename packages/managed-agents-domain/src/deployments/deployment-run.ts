export type DeploymentRunErrorType =
  | "environment_archived_error"
  | "agent_archived_error"
  | "environment_not_found_error"
  | "vault_not_found_error"
  | "vault_archived_error"
  | "file_not_found_error"
  | "memory_store_archived_error"
  | "skill_not_found_error"
  | "session_resource_not_found_error"
  | "workspace_archived_error"
  | "organization_disabled_error"
  | "session_rate_limited_error"
  | "session_creation_rejected_error"
  | "unknown_error"
  | "self_hosted_resources_unsupported_error"
  | "mcp_egress_blocked_error";

export type DeploymentRunTriggerContext =
  | { kind: "manual" }
  | { kind: "schedule"; scheduledAt: string };

export interface DeploymentRun {
  id: string;
  agent: { id: string; version: number };
  createdAt: string;
  deploymentId: string;
  error: { type: DeploymentRunErrorType; message: string } | null;
  sessionId: string | null;
  triggerContext: DeploymentRunTriggerContext;
}
