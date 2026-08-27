import type {
  Deployment,
  DeploymentResourceSecret,
} from "../domain/deployment";
import type {
  DeploymentRun,
  DeploymentRunErrorType,
} from "../domain/deployment-run";

export interface LaunchDeploymentSession {
  workspaceId: string;
  deployment: Deployment;
  resourceSecrets: DeploymentResourceSecret[];
  run: DeploymentRun;
}

export type LaunchDeploymentSessionResult =
  | { type: "launched"; sessionId: string }
  | {
      type: "rejected";
      errorType: DeploymentRunErrorType;
      message: string;
    };

export interface DeploymentSessionLauncherPort {
  launch(input: LaunchDeploymentSession): Promise<LaunchDeploymentSessionResult>;
}
