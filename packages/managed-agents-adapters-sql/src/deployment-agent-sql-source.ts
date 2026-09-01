import type { SqlClient } from "@open-managed-agents/sql-client";
import type {
  Agent,
  DeploymentAgentSourcePort,
  FindDeploymentAgent,
} from "@open-managed-agents/managed-agents-application";
import { SqlAgentPersistence } from "./agents-sql-persistence";

export class SqlDeploymentAgentSource implements DeploymentAgentSourcePort {
  private readonly agents: SqlAgentPersistence;

  constructor(client: SqlClient) {
    this.agents = new SqlAgentPersistence(client);
  }

  async find(input: FindDeploymentAgent): Promise<Agent | null> {
    const current = await this.agents.findCurrent({
      workspaceId: input.workspaceId,
      agentId: input.selector.agentId,
    });
    if (current === null) return null;
    if (input.selector.kind === "latest" || current.version === input.selector.version) {
      return current;
    }
    const version = await this.agents.findVersion({
      workspaceId: input.workspaceId,
      agentId: input.selector.agentId,
      version: input.selector.version,
    });
    return version === null
      ? null
      : { ...version, archivedAt: current.archivedAt };
  }
}
