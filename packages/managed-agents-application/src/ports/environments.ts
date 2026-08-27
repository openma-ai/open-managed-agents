import type {
  Environment,
  EnvironmentConfig,
  EnvironmentNetwork,
  EnvironmentPackages,
} from "../domain/environment";

export type EnvironmentNetworkInput =
  | { type: "unrestricted" }
  | {
      type: "limited";
      allowMcpServers?: boolean | null;
      allowPackageManagers?: boolean | null;
      allowedHosts?: string[] | null;
    };

export type EnvironmentNetworkView = EnvironmentNetwork;

export interface EnvironmentPackagesInput {
  apt?: string[] | null;
  cargo?: string[] | null;
  gem?: string[] | null;
  go?: string[] | null;
  npm?: string[] | null;
  pip?: string[] | null;
}

export type EnvironmentPackagesView = EnvironmentPackages;

export type EnvironmentConfigInput =
  | {
      type: "cloud";
      networking?: EnvironmentNetworkInput | null;
      packages?: EnvironmentPackagesInput | null;
    }
  | { type: "self_hosted" };

export type EnvironmentConfigView = EnvironmentConfig;

export type EnvironmentView = Environment;

export interface CreateEnvironmentCommand {
  name: string;
  config?: EnvironmentConfigInput | null;
  description?: string | null;
  metadata?: Record<string, string>;
  scope?: "organization" | "account" | null;
}

export interface RetrieveEnvironmentQuery {
  environmentId: string;
}

export interface UpdateEnvironmentCommand {
  environmentId: string;
  config?: EnvironmentConfigInput | null;
  description?: string | null;
  metadata?: Record<string, string | null>;
  name?: string | null;
  scope?: "organization" | "account" | null;
}

export interface ListEnvironmentsQuery {
  pageSize?: number;
  cursor?: string;
  includeArchived?: boolean;
}

export interface EnvironmentsPage {
  environments: EnvironmentView[];
  nextCursor: string | null;
}

export interface DeleteEnvironmentCommand {
  environmentId: string;
}

export interface ArchiveEnvironmentCommand {
  environmentId: string;
}

export type CreateEnvironmentResult =
  | { type: "created"; environment: EnvironmentView }
  | { type: "invalid_request"; message: string };

export type RetrieveEnvironmentResult =
  | { type: "found"; environment: EnvironmentView }
  | { type: "not_found" };

export type UpdateEnvironmentResult =
  | { type: "updated"; environment: EnvironmentView }
  | { type: "invalid_request"; message: string }
  | { type: "version_conflict"; message: string }
  | { type: "not_found" };

export type ListEnvironmentsResult =
  | { type: "page"; page: EnvironmentsPage }
  | { type: "invalid_request"; message: string };

export type DeleteEnvironmentResult =
  | { type: "deleted"; environmentId: string }
  | { type: "not_found" };

export type ArchiveEnvironmentResult =
  | { type: "archived"; environment: EnvironmentView }
  | { type: "not_found" };

export interface EnvironmentsApplicationPort {
  createEnvironment(command: CreateEnvironmentCommand): Promise<CreateEnvironmentResult>;
  retrieveEnvironment(query: RetrieveEnvironmentQuery): Promise<RetrieveEnvironmentResult>;
  updateEnvironment(command: UpdateEnvironmentCommand): Promise<UpdateEnvironmentResult>;
  listEnvironments(query: ListEnvironmentsQuery): Promise<ListEnvironmentsResult>;
  deleteEnvironment(command: DeleteEnvironmentCommand): Promise<DeleteEnvironmentResult>;
  archiveEnvironment(command: ArchiveEnvironmentCommand): Promise<ArchiveEnvironmentResult>;
}
