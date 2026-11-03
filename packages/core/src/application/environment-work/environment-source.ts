import type { Environment } from "../domain/environment.js";

export interface FindEnvironmentWorkEnvironment {
  workspaceId: string;
  environmentId: string;
}

export interface EnvironmentWorkEnvironmentSourcePort {
  find(
    input: FindEnvironmentWorkEnvironment,
  ): Promise<Environment | null>;
}
