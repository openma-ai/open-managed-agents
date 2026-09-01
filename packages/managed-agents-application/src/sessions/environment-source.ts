import type { Environment } from "../domain/environment";

export interface FindSessionEnvironment {
  workspaceId: string;
  environmentId: string;
}

export interface SessionEnvironmentSourcePort {
  find(input: FindSessionEnvironment): Promise<Environment | null>;
}
