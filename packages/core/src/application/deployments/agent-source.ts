import type { Agent } from "../domain/agent.js";
import type { DeploymentAgentSelection } from "../domain/deployment.js";

export interface FindDeploymentAgent {
  workspaceId: string;
  selector: DeploymentAgentSelection;
}

export interface DeploymentAgentSourcePort {
  find(input: FindDeploymentAgent): Promise<Agent | null>;
}
