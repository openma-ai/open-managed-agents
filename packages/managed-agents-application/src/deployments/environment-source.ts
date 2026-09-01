import type { Environment } from "../domain/environment";

export interface FindDeploymentEnvironment {
  workspaceId: string;
  environmentId: string;
}

export interface DeploymentEnvironmentSourcePort {
  find(input: FindDeploymentEnvironment): Promise<Environment | null>;
}
