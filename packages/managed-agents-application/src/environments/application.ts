import type {
  Environment,
  EnvironmentConfig,
  EnvironmentPackages,
} from "../domain/environment";
import type {
  ArchiveEnvironmentCommand,
  ArchiveEnvironmentResult,
  CreateEnvironmentCommand,
  CreateEnvironmentResult,
  DeleteEnvironmentCommand,
  DeleteEnvironmentResult,
  EnvironmentConfigInput,
  EnvironmentPackagesInput,
  EnvironmentsApplicationPort,
  ListEnvironmentsQuery,
  ListEnvironmentsResult,
  RetrieveEnvironmentQuery,
  RetrieveEnvironmentResult,
  UpdateEnvironmentCommand,
  UpdateEnvironmentResult,
} from "../ports/environments";
import type { EnvironmentStore } from "@open-managed-agents/environment-store";

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

function encodeEnvironmentCursor(environment: Environment): string {
  return `environments.${encodeCursorPart(environment.createdAt)}.${encodeCursorPart(environment.id)}`;
}

function decodeEnvironmentCursor(
  value: string,
): { createdAt: string; environmentId: string } | null {
  const [scope, createdAt, environmentId, extra] = value.split(".");
  if (
    scope !== "environments" ||
    createdAt === undefined ||
    environmentId === undefined ||
    extra !== undefined
  ) return null;
  const decodedCreatedAt = decodeCursorPart(createdAt);
  const decodedEnvironmentId = decodeCursorPart(environmentId);
  if (
    decodedCreatedAt === null ||
    decodedEnvironmentId === null ||
    decodedEnvironmentId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return { createdAt: decodedCreatedAt, environmentId: decodedEnvironmentId };
}

function normalizePackages(
  input: EnvironmentPackagesInput | null | undefined,
): EnvironmentPackages {
  return {
    apt: input?.apt ?? [],
    cargo: input?.cargo ?? [],
    gem: input?.gem ?? [],
    go: input?.go ?? [],
    npm: input?.npm ?? [],
    pip: input?.pip ?? [],
  };
}

function normalizeConfig(
  input: EnvironmentConfigInput | null | undefined,
): EnvironmentConfig {
  if (input?.type === "self_hosted") return { type: "self_hosted" };
  const networking = input?.type === "cloud" ? input.networking : undefined;
  return {
    type: "cloud",
    networking:
      networking?.type === "limited"
        ? {
            type: "limited",
            allowMcpServers: networking.allowMcpServers ?? false,
            allowPackageManagers: networking.allowPackageManagers ?? false,
            allowedHosts: networking.allowedHosts ?? [],
          }
        : { type: "unrestricted" },
    packages: normalizePackages(
      input?.type === "cloud" ? input.packages : undefined,
    ),
  };
}

function patchMetadata(
  current: Record<string, string>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export interface EnvironmentsApplicationServiceDependencies {
  workspaceId: string;
  store: EnvironmentStore;
  clock: { now(): Date };
  ids: { nextEnvironmentId(): string };
}

export class EnvironmentsApplicationService
  implements EnvironmentsApplicationPort
{
  constructor(
    private readonly dependencies: EnvironmentsApplicationServiceDependencies,
  ) {}

  async createEnvironment(
    command: CreateEnvironmentCommand,
  ): Promise<CreateEnvironmentResult> {
    if (command.name.trim().length === 0) {
      return { type: "invalid_request", message: "Environment name must not be empty" };
    }
    const timestamp = this.dependencies.clock.now().toISOString();
    const environment: Environment = {
      id: this.dependencies.ids.nextEnvironmentId(),
      archivedAt: null,
      config: normalizeConfig(command.config),
      createdAt: timestamp,
      description: command.description ?? null,
      metadata: command.metadata ?? {},
      name: command.name,
      updatedAt: timestamp,
      ...(command.scope != null && { scope: command.scope }),
    };
    const record = await this.dependencies.store.insert({
      workspaceId: this.dependencies.workspaceId,
      environment,
    });
    return { type: "created", environment: record.environment };
  }

  async retrieveEnvironment(
    query: RetrieveEnvironmentQuery,
  ): Promise<RetrieveEnvironmentResult> {
    const record = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: query.environmentId,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", environment: record.environment };
  }

  async updateEnvironment(
    command: UpdateEnvironmentCommand,
  ): Promise<UpdateEnvironmentResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
    });
    if (current === null) return { type: "not_found" };
    if (current.environment.archivedAt !== null) {
      return {
        type: "version_conflict",
        message: `Environment ${command.environmentId} is archived and read-only`,
      };
    }
    if (command.name !== undefined && command.name !== null && command.name.trim().length === 0) {
      return { type: "invalid_request", message: "Environment name must not be empty" };
    }
    const next: Environment = {
      ...current.environment,
      ...(command.config !== undefined && { config: normalizeConfig(command.config) }),
      ...(command.description !== undefined && { description: command.description }),
      ...(command.metadata !== undefined && {
        metadata: patchMetadata(current.environment.metadata, command.metadata),
      }),
      ...(command.name !== undefined && command.name !== null && { name: command.name }),
      updatedAt: this.dependencies.clock.now().toISOString(),
    };
    if (command.scope !== undefined) {
      if (command.scope === null) delete next.scope;
      else next.scope = command.scope;
    }
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
      expectedRevision: current.revision,
      next,
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `Environment changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return { type: "updated", environment: replaced.record.environment };
  }

  async listEnvironments(
    query: ListEnvironmentsQuery,
  ): Promise<ListEnvironmentsResult> {
    const position =
      query.cursor === undefined ? undefined : decodeEnvironmentCursor(query.cursor);
    if (position === null) {
      return { type: "invalid_request", message: "Invalid environments page cursor" };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      limit: pageSize + 1,
      includeArchived: query.includeArchived ?? false,
      ...(position !== undefined && { position }),
    });
    const hasMore = records.length > pageSize;
    const selected = hasMore ? records.slice(0, pageSize) : records;
    const environments = selected.map((record) => record.environment);
    const last = environments[environments.length - 1];
    return {
      type: "page",
      page: {
        environments,
        nextCursor:
          hasMore && last !== undefined ? encodeEnvironmentCursor(last) : null,
      },
    };
  }

  async deleteEnvironment(
    command: DeleteEnvironmentCommand,
  ): Promise<DeleteEnvironmentResult> {
    const result = await this.dependencies.store.delete({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
    });
    return result.type === "not_found"
      ? { type: "not_found" }
      : { type: "deleted", environmentId: command.environmentId };
  }

  async archiveEnvironment(
    command: ArchiveEnvironmentCommand,
  ): Promise<ArchiveEnvironmentResult> {
    const result = await this.dependencies.store.archive({
      workspaceId: this.dependencies.workspaceId,
      environmentId: command.environmentId,
      archivedAt: this.dependencies.clock.now().toISOString(),
    });
    return result.type === "not_found"
      ? { type: "not_found" }
      : { type: "archived", environment: result.record.environment };
  }
}
