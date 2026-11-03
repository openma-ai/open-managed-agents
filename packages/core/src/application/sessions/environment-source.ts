import type { Environment } from "../domain/environment.js";

export interface FindSessionEnvironment {
  workspaceId: string;
  environmentId: string;
}

export interface SessionEnvironmentSourcePort {
  find(input: FindSessionEnvironment): Promise<Environment | null>;
}
