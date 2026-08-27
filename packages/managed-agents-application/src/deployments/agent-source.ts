import type { Agent } from "../domain/agent";
import type { DeploymentAgentSelection } from "../domain/deployment";

export interface FindDeploymentAgent {
  workspaceId: string;
  selector: DeploymentAgentSelection;
}

export interface DeploymentAgentSourcePort {
  find(input: FindDeploymentAgent): Promise<Agent | null>;
}
