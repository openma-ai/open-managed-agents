import type { Agent } from "../domain/agent";

export interface FindSessionAgent {
  workspaceId: string;
  agentId: string;
}

export interface FindSessionAgentVersion extends FindSessionAgent {
  version: number;
}

export interface SessionAgentSourcePort {
  findCurrent(input: FindSessionAgent): Promise<Agent | null>;
  findVersion(input: FindSessionAgentVersion): Promise<Agent | null>;
}
