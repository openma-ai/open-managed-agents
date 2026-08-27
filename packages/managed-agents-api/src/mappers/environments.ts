import type {
  EnvironmentCreateBody,
  EnvironmentListQuery,
  EnvironmentUpdateBody,
} from "../contracts/environments";
import type {
  ArchiveEnvironmentCommand,
  CreateEnvironmentCommand,
  DeleteEnvironmentCommand,
  EnvironmentConfigInput,
  EnvironmentConfigView,
  EnvironmentPackagesInput,
  EnvironmentPackagesView,
  EnvironmentView,
  ListEnvironmentsQuery,
  RetrieveEnvironmentQuery,
  UpdateEnvironmentCommand,
} from "../ports/environments";

export function toArchiveEnvironmentCommand(
  environmentId: string,
): ArchiveEnvironmentCommand {
  return { environmentId };
}

export function toDeleteEnvironmentCommand(
  environmentId: string,
): DeleteEnvironmentCommand {
  return { environmentId };
}

export function toRetrieveEnvironmentQuery(
  environmentId: string,
): RetrieveEnvironmentQuery {
  return { environmentId };
}

function toPackagesInput(
  packages: NonNullable<
    Extract<NonNullable<EnvironmentCreateBody["config"]>, { type: "cloud" }>["packages"]
  >,
): EnvironmentPackagesInput {
  return {
    ...(packages.apt !== undefined && { apt: packages.apt }),
    ...(packages.cargo !== undefined && { cargo: packages.cargo }),
    ...(packages.gem !== undefined && { gem: packages.gem }),
    ...(packages.go !== undefined && { go: packages.go }),
    ...(packages.npm !== undefined && { npm: packages.npm }),
    ...(packages.pip !== undefined && { pip: packages.pip }),
  };
}

function toConfigInput(
  config: NonNullable<EnvironmentCreateBody["config"]>,
): EnvironmentConfigInput {
  if (config.type === "self_hosted") return { type: config.type };
  return {
    type: config.type,
    ...(config.networking !== undefined && {
      networking:
        config.networking === null
          ? null
          : config.networking.type === "unrestricted"
            ? { type: config.networking.type }
            : {
                type: config.networking.type,
                ...(config.networking.allow_mcp_servers !== undefined && {
                  allowMcpServers: config.networking.allow_mcp_servers,
                }),
                ...(config.networking.allow_package_managers !== undefined && {
                  allowPackageManagers:
                    config.networking.allow_package_managers,
                }),
                ...(config.networking.allowed_hosts !== undefined && {
                  allowedHosts: config.networking.allowed_hosts,
                }),
              },
    }),
    ...(config.packages !== undefined && {
      packages:
        config.packages === null ? null : toPackagesInput(config.packages),
    }),
  };
}

export function toCreateEnvironmentCommand(
  body: EnvironmentCreateBody,
): CreateEnvironmentCommand {
  return {
    name: body.name,
    ...(body.config !== undefined && {
      config: body.config === null ? null : toConfigInput(body.config),
    }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.scope !== undefined && { scope: body.scope }),
  };
}

export function toUpdateEnvironmentCommand(
  environmentId: string,
  body: EnvironmentUpdateBody,
): UpdateEnvironmentCommand {
  return {
    environmentId,
    ...(body.config !== undefined && {
      config: body.config === null ? null : toConfigInput(body.config),
    }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.name !== undefined && { name: body.name }),
    ...(body.scope !== undefined && { scope: body.scope }),
  };
}

export function toListEnvironmentsQuery(
  query: EnvironmentListQuery,
): ListEnvironmentsQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query.include_archived !== undefined && {
      includeArchived: query.include_archived,
    }),
  };
}

function fromPackages(packages: EnvironmentPackagesView): object {
  return {
    type: "packages",
    apt: packages.apt,
    cargo: packages.cargo,
    gem: packages.gem,
    go: packages.go,
    npm: packages.npm,
    pip: packages.pip,
  };
}

function fromConfig(config: EnvironmentConfigView): object {
  if (config.type === "self_hosted") return { type: config.type };
  return {
    type: config.type,
    networking:
      config.networking.type === "unrestricted"
        ? { type: config.networking.type }
        : {
            type: config.networking.type,
            allow_mcp_servers: config.networking.allowMcpServers,
            allow_package_managers: config.networking.allowPackageManagers,
            allowed_hosts: config.networking.allowedHosts,
          },
    packages: fromPackages(config.packages),
  };
}

export function toEnvironmentResponse(environment: EnvironmentView): object {
  return {
    id: environment.id,
    archived_at: environment.archivedAt,
    config: fromConfig(environment.config),
    created_at: environment.createdAt,
    description: environment.description,
    metadata: environment.metadata,
    name: environment.name,
    type: "environment",
    updated_at: environment.updatedAt,
    ...(environment.scope !== undefined && { scope: environment.scope }),
  };
}
