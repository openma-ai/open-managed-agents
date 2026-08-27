import type {
  Deployment,
  DeploymentPauseErrorType,
  DeploymentResource,
  DeploymentResourceSecret,
} from "../domain/deployment";
import type { DeploymentRun } from "../domain/deployment-run";
import type {
  CreateDeploymentCommand,
  CreateDeploymentResult,
  ChangeDeploymentStateResult,
  DeploymentCommand,
  DeploymentsApplicationPort,
  ListDeploymentsQuery,
  ListDeploymentsResult,
  RetrieveDeploymentQuery,
  RetrieveDeploymentResult,
  RunDeploymentResult,
  UpdateDeploymentCommand,
  UpdateDeploymentResult,
} from "../ports/deployments";
import type { DeploymentAgentSourcePort } from "./agent-source";
import type { DeploymentEnvironmentSourcePort } from "./environment-source";
import type { DeploymentFileSourcePort } from "./file-source";
import type { DeploymentMemoryStoreSourcePort } from "./memory-store-source";
import type {
  DeploymentStore,
  StoredDeployment,
} from "@open-managed-agents/deployment-store";
import type { DeploymentSchedulePlannerPort } from "./schedule-planner";
import type { DeploymentVaultSourcePort } from "./vault-source";
import type { DeploymentSessionLauncherPort } from "./session-launcher";
import type { DeploymentRunStore } from "@open-managed-agents/deployment-run-store";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeDeploymentCursor(deployment: Deployment): string {
  return `deployments.${encodeCursorPart(deployment.createdAt)}.${encodeCursorPart(deployment.id)}`;
}

function decodeDeploymentCursor(
  value: string,
): { createdAt: string; deploymentId: string } | null {
  const [scope, createdAt, deploymentId, extra] = value.split(".");
  if (
    scope !== "deployments" ||
    createdAt === undefined ||
    deploymentId === undefined ||
    extra !== undefined
  ) return null;
  const decodedCreatedAt = decodeCursorPart(createdAt);
  const decodedDeploymentId = decodeCursorPart(deploymentId);
  if (
    decodedCreatedAt === null ||
    decodedDeploymentId === null ||
    decodedDeploymentId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return { createdAt: decodedCreatedAt, deploymentId: decodedDeploymentId };
}

function patchMetadata(
  current: Record<string, string>,
  patch: Record<string, string | null> | null,
): Record<string, string> {
  if (patch === null) return {};
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function validMountPath(value: string): boolean {
  return value.startsWith("/") && !value.split("/").includes("..");
}

function validRepositoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validateDeploymentDefinition(input: {
  name: string;
  initialEvents: CreateDeploymentCommand["initialEvents"];
  metadata: Record<string, string>;
  resources: Array<
    | DeploymentResource
    | NonNullable<CreateDeploymentCommand["resources"]>[number]
  >;
  vaultIds: string[];
}): string | null {
  if (input.name.length < 1 || input.name.length > 255) {
    return "Deployment name must contain 1 to 255 characters";
  }
  if (/\p{Cc}/u.test(input.name)) {
    return "Deployment name must not contain control characters";
  }
  if (input.initialEvents.length < 1 || input.initialEvents.length > 50) {
    return "Deployment initial events must contain 1 to 50 events";
  }
  const metadataEntries = Object.entries(input.metadata);
  if (metadataEntries.length > 16) {
    return "Deployment metadata may contain at most 16 keys";
  }
  for (const [key, value] of metadataEntries) {
    if (key.length < 1 || key.length > 64) {
      return "Deployment metadata keys must contain 1 to 64 characters";
    }
    if (value.length > 512) {
      return "Deployment metadata values may contain at most 512 characters";
    }
  }
  if (input.resources.length > 500) {
    return "Deployment may contain at most 500 resources";
  }
  const mountPaths = new Set<string>();
  const memoryStoreIds = new Set<string>();
  for (const resource of input.resources) {
    if ("mountPath" in resource && resource.mountPath != null) {
      if (!validMountPath(resource.mountPath)) {
        return "Deployment resource mount path must be absolute and may not traverse parents";
      }
      if (mountPaths.has(resource.mountPath)) {
        return `Deployment resource mount path ${resource.mountPath} is already in use`;
      }
      mountPaths.add(resource.mountPath);
    }
    if (resource.kind === "github_repository") {
      if (!validRepositoryUrl(resource.url)) {
        return "GitHub repository URL must be an HTTP(S) repository URL";
      }
      if (
        "authorizationToken" in resource &&
        resource.authorizationToken.length === 0
      ) {
        return "GitHub authorization token must not be empty";
      }
    }
    if (resource.kind === "memory_store") {
      if (memoryStoreIds.has(resource.memoryStoreId)) {
        return `Memory store ${resource.memoryStoreId} is attached more than once`;
      }
      memoryStoreIds.add(resource.memoryStoreId);
      if (resource.instructions != null && resource.instructions.length > 4096) {
        return "Memory store instructions must not exceed 4096 characters";
      }
    }
  }
  if (input.vaultIds.length > 50) {
    return "Deployment may reference at most 50 vaults";
  }
  const vaultIds = new Set<string>();
  for (const vaultId of input.vaultIds) {
    if (vaultIds.has(vaultId)) return `Vault ${vaultId} is attached more than once`;
    vaultIds.add(vaultId);
  }
  return null;
}

export interface DeploymentsApplicationServiceDependencies {
  workspaceId: string;
  agents: DeploymentAgentSourcePort;
  environments: DeploymentEnvironmentSourcePort;
  files: DeploymentFileSourcePort;
  memoryStores: DeploymentMemoryStoreSourcePort;
  store: DeploymentStore;
  runs: DeploymentRunStore;
  schedules: DeploymentSchedulePlannerPort;
  sessions: DeploymentSessionLauncherPort;
  vaults: DeploymentVaultSourcePort;
  clock: { now(): Date };
  ids: {
    nextDeploymentId(): string;
    nextDeploymentRunId(): string;
  };
}

export class DeploymentsApplicationService
  implements DeploymentsApplicationPort
{
  constructor(
    private readonly dependencies: DeploymentsApplicationServiceDependencies,
  ) {}

  async createDeployment(
    command: CreateDeploymentCommand,
  ): Promise<CreateDeploymentResult> {
    const invalid = validateDeploymentDefinition({
      name: command.name,
      initialEvents: command.initialEvents,
      metadata: command.metadata ?? {},
      resources: command.resources ?? [],
      vaultIds: command.vaultIds ?? [],
    });
    if (invalid !== null) {
      return { type: "invalid_request", message: invalid };
    }
    const agent = await this.dependencies.agents.find({
      workspaceId: this.dependencies.workspaceId,
      selector: command.agent,
    });
    if (agent === null || agent.archivedAt !== null) {
      return {
        type: "dependency_not_found",
        message: `Agent ${command.agent.agentId} was not found`,
      };
    }

    const environment = await this.dependencies.environments.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
    });
    if (environment === null || environment.archivedAt !== null) {
      return {
        type: "dependency_not_found",
        message: `Environment ${command.environmentId} was not found`,
      };
    }

    const resources: DeploymentResource[] = [];
    const resourceSecrets: DeploymentResourceSecret[] = [];
    for (const [resourceIndex, resource] of (command.resources ?? []).entries()) {
      if (resource.kind === "file") {
        const found = await this.dependencies.files.find({
          workspaceId: this.dependencies.workspaceId,
          fileId: resource.fileId,
        });
        if (found === null) {
          return {
            type: "dependency_not_found",
            message: `File ${resource.fileId} was not found`,
          };
        }
        resources.push({ ...resource });
        continue;
      }
      if (resource.kind === "memory_store") {
        const found = await this.dependencies.memoryStores.find({
          workspaceId: this.dependencies.workspaceId,
          memoryStoreId: resource.memoryStoreId,
        });
        if (found === null || found.archivedAt !== null) {
          return {
            type: "dependency_not_found",
            message: `Memory store ${resource.memoryStoreId} was not found`,
          };
        }
        resources.push({ ...resource });
        continue;
      }
      resources.push({
        kind: resource.kind,
        url: resource.url,
        ...(resource.checkout !== undefined && { checkout: resource.checkout }),
        ...(resource.mountPath !== undefined && { mountPath: resource.mountPath }),
      });
      resourceSecrets.push({
        kind: "github_repository_token",
        resourceIndex,
        authorizationToken: resource.authorizationToken,
      });
    }

    const vaultIds = command.vaultIds ?? [];
    for (const vaultId of vaultIds) {
      const found = await this.dependencies.vaults.find({
        workspaceId: this.dependencies.workspaceId,
        vaultId,
      });
      if (found === null || found.archivedAt !== null) {
        return {
          type: "dependency_not_found",
          message: `Vault ${vaultId} was not found`,
        };
      }
    }

    const timestamp = this.dependencies.clock.now().toISOString();
    const schedule =
      command.schedule == null
        ? null
        : await this.dependencies.schedules.plan({
            expression: command.schedule.expression,
            timezone: command.schedule.timezone,
            after: timestamp,
          });
    if (schedule !== null && schedule.type === "invalid_schedule") {
      return { type: "invalid_request", message: schedule.message };
    }

    const deployment: Deployment = {
      id: this.dependencies.ids.nextDeploymentId(),
      agent: { id: agent.id, version: agent.version },
      archivedAt: null,
      createdAt: timestamp,
      description: command.description ?? null,
      environmentId: environment.id,
      initialEvents: structuredClone(command.initialEvents),
      metadata: { ...(command.metadata ?? {}) },
      name: command.name,
      pausedReason: null,
      resources,
      schedule: schedule === null ? null : schedule.schedule,
      status: "active",
      updatedAt: timestamp,
      vaultIds: [...vaultIds],
      ...(command.budget !== undefined && { budget: command.budget }),
    };
    const inserted = await this.dependencies.store.insert({
      workspaceId: this.dependencies.workspaceId,
      record: { deployment, resourceSecrets },
    });
    return { type: "created", deployment: inserted.deployment };
  }

  async retrieveDeployment(
    query: RetrieveDeploymentQuery,
  ): Promise<RetrieveDeploymentResult> {
    const record = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      deploymentId: query.deploymentId,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", deployment: record.deployment };
  }

  async updateDeployment(
    command: UpdateDeploymentCommand,
  ): Promise<UpdateDeploymentResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      deploymentId: command.deploymentId,
    });
    if (current === null) return { type: "not_found" };

    const invalid = validateDeploymentDefinition({
      name: command.name ?? current.deployment.name,
      initialEvents:
        command.initialEvents ?? current.deployment.initialEvents,
      metadata:
        command.metadata === undefined
          ? current.deployment.metadata
          : patchMetadata(current.deployment.metadata, command.metadata),
      resources:
        command.resources === undefined
          ? current.deployment.resources
          : command.resources ?? [],
      vaultIds:
        command.vaultIds === undefined
          ? current.deployment.vaultIds
          : command.vaultIds ?? [],
    });
    if (invalid !== null) {
      return { type: "invalid_request", message: invalid };
    }

    let agent = current.deployment.agent;
    if (command.agent !== undefined) {
      const found = await this.dependencies.agents.find({
        workspaceId: this.dependencies.workspaceId,
        selector: command.agent,
      });
      if (found === null || found.archivedAt !== null) {
        return {
          type: "dependency_not_found",
          message: `Agent ${command.agent.agentId} was not found`,
        };
      }
      agent = { id: found.id, version: found.version };
    }

    let environmentId = current.deployment.environmentId;
    if (command.environmentId !== undefined) {
      const found = await this.dependencies.environments.find({
        workspaceId: this.dependencies.workspaceId,
        environmentId: command.environmentId,
      });
      if (found === null || found.archivedAt !== null) {
        return {
          type: "dependency_not_found",
          message: `Environment ${command.environmentId} was not found`,
        };
      }
      environmentId = found.id;
    }

    let resources = current.deployment.resources;
    let resourceSecrets = current.resourceSecrets;
    if (command.resources !== undefined) {
      resources = [];
      resourceSecrets = [];
      for (const [resourceIndex, resource] of (command.resources ?? []).entries()) {
        if (resource.kind === "file") {
          const found = await this.dependencies.files.find({
            workspaceId: this.dependencies.workspaceId,
            fileId: resource.fileId,
          });
          if (found === null) {
            return {
              type: "dependency_not_found",
              message: `File ${resource.fileId} was not found`,
            };
          }
          resources.push({ ...resource });
          continue;
        }
        if (resource.kind === "memory_store") {
          const found = await this.dependencies.memoryStores.find({
            workspaceId: this.dependencies.workspaceId,
            memoryStoreId: resource.memoryStoreId,
          });
          if (found === null || found.archivedAt !== null) {
            return {
              type: "dependency_not_found",
              message: `Memory store ${resource.memoryStoreId} was not found`,
            };
          }
          resources.push({ ...resource });
          continue;
        }
        resources.push({
          kind: resource.kind,
          url: resource.url,
          ...(resource.checkout !== undefined && { checkout: resource.checkout }),
          ...(resource.mountPath !== undefined && { mountPath: resource.mountPath }),
        });
        resourceSecrets.push({
          kind: "github_repository_token",
          resourceIndex,
          authorizationToken: resource.authorizationToken,
        });
      }
    }

    let vaultIds = current.deployment.vaultIds;
    if (command.vaultIds !== undefined) {
      vaultIds = command.vaultIds ?? [];
      for (const vaultId of vaultIds) {
        const found = await this.dependencies.vaults.find({
          workspaceId: this.dependencies.workspaceId,
          vaultId,
        });
        if (found === null || found.archivedAt !== null) {
          return {
            type: "dependency_not_found",
            message: `Vault ${vaultId} was not found`,
          };
        }
      }
    }

    const timestamp = this.dependencies.clock.now().toISOString();
    let schedule = current.deployment.schedule;
    if (command.schedule !== undefined) {
      if (command.schedule === null) {
        schedule = null;
      } else {
        const planned = await this.dependencies.schedules.plan({
          expression: command.schedule.expression,
          timezone: command.schedule.timezone,
          after: timestamp,
        });
        if (planned.type === "invalid_schedule") {
          return { type: "invalid_request", message: planned.message };
        }
        schedule = planned.schedule;
      }
    }

    const next: Deployment = {
      ...current.deployment,
      agent,
      environmentId,
      resources,
      schedule,
      vaultIds: [...vaultIds],
      ...(command.budget !== undefined && { budget: command.budget }),
      ...(command.description !== undefined && {
        description: command.description,
      }),
      ...(command.initialEvents !== undefined && {
        initialEvents: structuredClone(command.initialEvents),
      }),
      ...(command.metadata !== undefined && {
        metadata: patchMetadata(current.deployment.metadata, command.metadata),
      }),
      ...(command.name !== undefined && { name: command.name }),
      updatedAt: timestamp,
    };
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      deploymentId: command.deploymentId,
      expectedRevision: current.revision,
      next: {
        deployment: next,
        resourceSecrets: structuredClone(resourceSecrets),
      },
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Deployment changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "updated", deployment: replaced.record.deployment };
  }

  private async replaceState(
    current: StoredDeployment,
    next: Deployment,
  ): Promise<ChangeDeploymentStateResult> {
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      deploymentId: current.deployment.id,
      expectedRevision: current.revision,
      next: {
        deployment: next,
        resourceSecrets: current.resourceSecrets,
      },
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "conflict",
        message: `Deployment changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "changed", deployment: replaced.record.deployment };
  }

  private async readinessError(
    record: StoredDeployment,
  ): Promise<DeploymentPauseErrorType | null> {
    const deployment = record.deployment;
    const agent = await this.dependencies.agents.find({
      workspaceId: this.dependencies.workspaceId,
      selector: {
        kind: "versioned",
        agentId: deployment.agent.id,
        version: deployment.agent.version,
      },
    });
    if (agent === null || agent.archivedAt !== null) {
      return "agent_archived_error";
    }
    const environment = await this.dependencies.environments.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: deployment.environmentId,
    });
    if (environment === null) return "environment_not_found_error";
    if (environment.archivedAt !== null) return "environment_archived_error";

    for (const [resourceIndex, resource] of deployment.resources.entries()) {
      if (resource.kind === "file") {
        const found = await this.dependencies.files.find({
          workspaceId: this.dependencies.workspaceId,
          fileId: resource.fileId,
        });
        if (found === null) return "file_not_found_error";
      } else if (resource.kind === "memory_store") {
        const found = await this.dependencies.memoryStores.find({
          workspaceId: this.dependencies.workspaceId,
          memoryStoreId: resource.memoryStoreId,
        });
        if (found === null || found.archivedAt !== null) {
          return "memory_store_archived_error";
        }
      } else {
        const secret = record.resourceSecrets.find(
          (candidate) => candidate.resourceIndex === resourceIndex,
        );
        if (secret === undefined) return "session_resource_not_found_error";
      }
    }
    for (const vaultId of deployment.vaultIds) {
      const found = await this.dependencies.vaults.find({
        workspaceId: this.dependencies.workspaceId,
        vaultId,
      });
      if (found === null) return "vault_not_found_error";
      if (found.archivedAt !== null) return "vault_archived_error";
    }
    return null;
  }

  async archiveDeployment(
    command: DeploymentCommand,
  ): Promise<ChangeDeploymentStateResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      deploymentId: command.deploymentId,
    });
    if (current === null) return { type: "not_found" };
    if (current.deployment.archivedAt !== null) {
      return {
        type: "conflict",
        message: `Deployment ${command.deploymentId} is already archived`,
      };
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    return this.replaceState(current, {
      ...current.deployment,
      archivedAt: timestamp,
      pausedReason: { kind: "manual" },
      status: "paused",
      updatedAt: timestamp,
    });
  }

  async pauseDeployment(
    command: DeploymentCommand,
  ): Promise<ChangeDeploymentStateResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      deploymentId: command.deploymentId,
    });
    if (current === null) return { type: "not_found" };
    if (current.deployment.archivedAt !== null) {
      return {
        type: "conflict",
        message: `Deployment ${command.deploymentId} is archived`,
      };
    }
    if (current.deployment.status === "paused") {
      return {
        type: "conflict",
        message: `Deployment ${command.deploymentId} is already paused`,
      };
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    return this.replaceState(current, {
      ...current.deployment,
      pausedReason: { kind: "manual" },
      status: "paused",
      updatedAt: timestamp,
    });
  }

  async unpauseDeployment(
    command: DeploymentCommand,
  ): Promise<ChangeDeploymentStateResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      deploymentId: command.deploymentId,
    });
    if (current === null) return { type: "not_found" };
    if (current.deployment.archivedAt !== null) {
      return {
        type: "conflict",
        message: `Deployment ${command.deploymentId} is archived`,
      };
    }
    if (current.deployment.status === "active") {
      return {
        type: "conflict",
        message: `Deployment ${command.deploymentId} is already active`,
      };
    }
    const readinessError = await this.readinessError(current);
    if (readinessError !== null) {
      return {
        type: "conflict",
        message: `Deployment ${command.deploymentId} is not ready: ${readinessError}`,
      };
    }
    return this.replaceState(current, {
      ...current.deployment,
      pausedReason: null,
      status: "active",
      updatedAt: this.dependencies.clock.now().toISOString(),
    });
  }

  async runDeployment(
    command: DeploymentCommand,
  ): Promise<RunDeploymentResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      deploymentId: command.deploymentId,
    });
    if (current === null) return { type: "not_found" };
    if (
      current.deployment.archivedAt !== null ||
      current.deployment.status !== "active"
    ) {
      return {
        type: "conflict",
        message: `Deployment ${command.deploymentId} is not active`,
      };
    }
    const pendingRun: DeploymentRun = {
      id: this.dependencies.ids.nextDeploymentRunId(),
      agent: { ...current.deployment.agent },
      createdAt: this.dependencies.clock.now().toISOString(),
      deploymentId: current.deployment.id,
      error: null,
      sessionId: null,
      triggerContext: { kind: "manual" },
    };
    const began = await this.dependencies.runs.beginManual({
      workspaceId: this.dependencies.workspaceId,
      deploymentId: current.deployment.id,
      expectedDeploymentRevision: current.revision,
      run: pendingRun,
    });
    if (began.type === "not_found") return { type: "not_found" };
    if (began.type === "not_runnable") {
      return {
        type: "conflict",
        message: `Deployment ${command.deploymentId} is not active`,
      };
    }
    if (began.type === "deployment_revision_conflict") {
      return {
        type: "conflict",
        message: `Deployment changed concurrently at revision ${began.actualRevision}`,
      };
    }

    const readinessError = await this.readinessError(current);
    let next: DeploymentRun;
    if (readinessError !== null) {
      next = {
        ...began.record.run,
        error: {
          type: readinessError,
          message: `Deployment ${command.deploymentId} could not create a session: ${readinessError}`,
        },
      };
    } else {
      const launched = await this.dependencies.sessions.launch({
        workspaceId: this.dependencies.workspaceId,
        deployment: current.deployment,
        resourceSecrets: current.resourceSecrets,
        run: began.record.run,
      });
      next =
        launched.type === "launched"
          ? { ...began.record.run, sessionId: launched.sessionId }
          : {
              ...began.record.run,
              error: { type: launched.errorType, message: launched.message },
            };
    }
    const finalized = await this.dependencies.runs.finalize({
      workspaceId: this.dependencies.workspaceId,
      deploymentRunId: began.record.run.id,
      expectedRevision: began.record.revision,
      next,
    });
    if (finalized.type === "not_found") {
      return {
        type: "conflict",
        message: `Deployment run ${began.record.run.id} disappeared before finalization`,
      };
    }
    if (finalized.type === "revision_conflict") {
      return {
        type: "conflict",
        message: `Deployment run changed concurrently at revision ${finalized.actualRevision}`,
      };
    }
    return { type: "started", run: finalized.record.run };
  }

  async listDeployments(
    query: ListDeploymentsQuery,
  ): Promise<ListDeploymentsResult> {
    const position =
      query.cursor === undefined
        ? undefined
        : decodeDeploymentCursor(query.cursor);
    if (position === null) {
      return {
        type: "invalid_request",
        message: "Invalid deployments page cursor",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      limit: pageSize + 1,
      includeArchived: query.includeArchived ?? false,
      ...(query.agentId !== undefined && { agentId: query.agentId }),
      ...(query.createdAtOrAfter !== undefined && {
        createdAtOrAfter: query.createdAtOrAfter,
      }),
      ...(query.createdAtOrBefore !== undefined && {
        createdAtOrBefore: query.createdAtOrBefore,
      }),
      ...(query.status !== undefined && { status: query.status }),
      ...(position !== undefined && { position }),
    });
    const hasMore = records.length > pageSize;
    const deployments = (hasMore ? records.slice(0, pageSize) : records).map(
      (record) => record.deployment,
    );
    const last = deployments[deployments.length - 1];
    return {
      type: "page",
      page: {
        deployments,
        nextCursor:
          hasMore && last !== undefined ? encodeDeploymentCursor(last) : null,
      },
    };
  }
}
