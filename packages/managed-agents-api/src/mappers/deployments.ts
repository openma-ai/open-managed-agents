import type {
  DeploymentCreateBody,
  DeploymentListQuery,
  DeploymentUpdateBody,
} from "../contracts/deployments";
import type { OutcomeRubric, SendableSessionEvent } from "../ports/session-events";
import type {
  CreateDeploymentCommand,
  DeploymentAgentSelector,
  DeploymentInitialEvent,
  DeploymentResourceInput,
  DeploymentResourceView,
  DeploymentView,
  ListDeploymentsQuery,
  UpdateDeploymentCommand,
} from "../ports/deployments";
import { fromRubric, fromUserMessageContent, toSendableSessionEvent } from "./session-events";

type WireDeploymentEvent = DeploymentCreateBody["initial_events"][number];
type WireDeploymentResource = NonNullable<DeploymentCreateBody["resources"]>[number];

function toAgentSelector(
  agent: DeploymentCreateBody["agent"],
): DeploymentAgentSelector {
  if (typeof agent === "string" || agent.version === undefined) {
    return {
      kind: "latest",
      agentId: typeof agent === "string" ? agent : agent.id,
    };
  }
  return { kind: "versioned", agentId: agent.id, version: agent.version };
}

function toDeploymentInitialEvent(
  event: WireDeploymentEvent,
): DeploymentInitialEvent {
  return toSendableSessionEvent(event) as DeploymentInitialEvent;
}

function toDeploymentResource(
  resource: WireDeploymentResource,
): DeploymentResourceInput {
  switch (resource.type) {
    case "file":
      return {
        kind: "file",
        fileId: resource.file_id,
        ...(resource.mount_path !== undefined && {
          mountPath: resource.mount_path,
        }),
      };
    case "github_repository":
      return {
        kind: "github_repository",
        authorizationToken: resource.authorization_token,
        url: resource.url,
        ...(resource.checkout !== undefined && { checkout: resource.checkout }),
        ...(resource.mount_path !== undefined && {
          mountPath: resource.mount_path,
        }),
      };
    case "memory_store":
      return {
        kind: "memory_store",
        memoryStoreId: resource.memory_store_id,
        ...(resource.access !== undefined && { access: resource.access }),
        ...(resource.instructions !== undefined && {
          instructions: resource.instructions,
        }),
      };
  }
}

function toBudget(
  budget: NonNullable<DeploymentCreateBody["budget"]>,
): { amountMinor: string; currency: "USD" } {
  return {
    amountMinor: budget.max_list_cost.amount,
    currency: budget.max_list_cost.currency,
  };
}

export function toCreateDeploymentCommand(
  body: DeploymentCreateBody,
): CreateDeploymentCommand {
  return {
    agent: toAgentSelector(body.agent),
    environmentId: body.environment_id,
    initialEvents: body.initial_events.map(toDeploymentInitialEvent),
    name: body.name,
    ...(body.budget !== undefined && {
      budget: body.budget === null ? null : toBudget(body.budget),
    }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.resources !== undefined && {
      resources: body.resources.map(toDeploymentResource),
    }),
    ...(body.schedule !== undefined && {
      schedule:
        body.schedule === null
          ? null
          : {
              expression: body.schedule.expression,
              timezone: body.schedule.timezone,
            },
    }),
    ...(body.vault_ids !== undefined && { vaultIds: body.vault_ids }),
  };
}

export function toUpdateDeploymentCommand(
  deploymentId: string,
  body: DeploymentUpdateBody,
): UpdateDeploymentCommand {
  return {
    deploymentId,
    ...(body.agent !== undefined && { agent: toAgentSelector(body.agent) }),
    ...(body.budget !== undefined && {
      budget: body.budget === null ? null : toBudget(body.budget),
    }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.environment_id !== undefined && {
      environmentId: body.environment_id,
    }),
    ...(body.initial_events !== undefined && {
      initialEvents: body.initial_events.map(toDeploymentInitialEvent),
    }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.name !== undefined && { name: body.name }),
    ...(body.resources !== undefined && {
      resources:
        body.resources === null
          ? null
          : body.resources.map(toDeploymentResource),
    }),
    ...(body.schedule !== undefined && {
      schedule:
        body.schedule === null
          ? null
          : {
              expression: body.schedule.expression,
              timezone: body.schedule.timezone,
            },
    }),
    ...(body.vault_ids !== undefined && { vaultIds: body.vault_ids }),
  };
}

export function toListDeploymentsQuery(
  query: DeploymentListQuery,
): ListDeploymentsQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query.agent_id !== undefined && { agentId: query.agent_id }),
    ...(query["created_at[gte]"] !== undefined && {
      createdAtOrAfter: query["created_at[gte]"],
    }),
    ...(query["created_at[lte]"] !== undefined && {
      createdAtOrBefore: query["created_at[lte]"],
    }),
    ...(query.include_archived !== undefined && {
      includeArchived: query.include_archived,
    }),
    ...(query.status !== undefined && { status: query.status }),
  };
}

function toInitialEventResponse(event: SendableSessionEvent): object {
  switch (event.type) {
    case "user.message":
      return {
        type: event.type,
        content: event.content.map(fromUserMessageContent),
      };
    case "user.define_outcome":
      return {
        type: event.type,
        description: event.description,
        rubric: fromRubric(event.rubric as OutcomeRubric),
        ...(event.maxIterations !== undefined && {
          max_iterations: event.maxIterations,
        }),
      };
    case "system.message":
      return {
        type: event.type,
        content: event.content.map((block) => ({
          type: "text",
          text: block.text,
        })),
      };
    default:
      throw new Error(`Unsupported deployment initial event: ${event.type}`);
  }
}

function toResourceResponse(resource: DeploymentResourceView): object {
  switch (resource.kind) {
    case "file":
      return {
        type: "file",
        file_id: resource.fileId,
        ...(resource.mountPath !== undefined && {
          mount_path: resource.mountPath,
        }),
      };
    case "github_repository":
      return {
        type: "github_repository",
        url: resource.url,
        ...(resource.checkout !== undefined && { checkout: resource.checkout }),
        ...(resource.mountPath !== undefined && {
          mount_path: resource.mountPath,
        }),
      };
    case "memory_store":
      return {
        type: "memory_store",
        memory_store_id: resource.memoryStoreId,
        ...(resource.access !== undefined && { access: resource.access }),
        ...(resource.instructions !== undefined && {
          instructions: resource.instructions,
        }),
      };
  }
}

export function toDeploymentResponse(deployment: DeploymentView): object {
  return {
    id: deployment.id,
    agent: {
      id: deployment.agent.id,
      type: "agent",
      version: deployment.agent.version,
    },
    archived_at: deployment.archivedAt,
    created_at: deployment.createdAt,
    description: deployment.description,
    environment_id: deployment.environmentId,
    initial_events: deployment.initialEvents.map(toInitialEventResponse),
    metadata: deployment.metadata,
    name: deployment.name,
    paused_reason:
      deployment.pausedReason === null
        ? null
        : deployment.pausedReason.kind === "manual"
          ? { type: "manual" }
          : {
              type: "error",
              error: { type: deployment.pausedReason.errorType },
            },
    resources: deployment.resources.map(toResourceResponse),
    schedule:
      deployment.schedule === null
        ? null
        : {
            type: "cron",
            expression: deployment.schedule.expression,
            timezone: deployment.schedule.timezone,
            ...(deployment.schedule.lastRunAt !== undefined && {
              last_run_at: deployment.schedule.lastRunAt,
            }),
            ...(deployment.schedule.upcomingRunsAt !== undefined && {
              upcoming_runs_at: deployment.schedule.upcomingRunsAt,
            }),
          },
    status: deployment.status,
    type: "deployment",
    updated_at: deployment.updatedAt,
    vault_ids: deployment.vaultIds,
    ...(deployment.budget !== undefined && {
      budget:
        deployment.budget === null
          ? null
          : {
              type: "limit",
              max_list_cost: {
                amount: deployment.budget.amountMinor,
                currency: deployment.budget.currency,
              },
            },
    }),
  };
}
