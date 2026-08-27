import type { DeploymentRunListQuery } from "../contracts/deployment-runs";
import type {
  DeploymentRunView,
  ListDeploymentRunsQuery,
} from "../ports/deployment-runs";

export function toListDeploymentRunsQuery(
  query: DeploymentRunListQuery,
): ListDeploymentRunsQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query["created_at[gt]"] !== undefined && {
      createdAfter: query["created_at[gt]"],
    }),
    ...(query["created_at[gte]"] !== undefined && {
      createdAtOrAfter: query["created_at[gte]"],
    }),
    ...(query["created_at[lt]"] !== undefined && {
      createdBefore: query["created_at[lt]"],
    }),
    ...(query["created_at[lte]"] !== undefined && {
      createdAtOrBefore: query["created_at[lte]"],
    }),
    ...(query.deployment_id !== undefined && {
      deploymentId: query.deployment_id,
    }),
    ...(query.has_error !== undefined && { hasError: query.has_error }),
    ...(query.trigger_type !== undefined && {
      triggerType: query.trigger_type,
    }),
  };
}

export function toDeploymentRunResponse(run: DeploymentRunView): object {
  return {
    id: run.id,
    agent: { id: run.agent.id, type: "agent", version: run.agent.version },
    created_at: run.createdAt,
    deployment_id: run.deploymentId,
    error:
      run.error === null
        ? null
        : { type: run.error.type, message: run.error.message },
    session_id: run.sessionId,
    trigger_context:
      run.triggerContext.kind === "manual"
        ? { type: "manual" }
        : {
            type: "schedule",
            scheduled_at: run.triggerContext.scheduledAt,
          },
    type: "deployment_run",
  };
}
