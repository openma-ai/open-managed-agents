import type { DeploymentRunStore } from "@open-managed-agents/deployment-run-store";
import { DeploymentRunsApplicationService } from "@open-managed-agents/managed-agents-application";

import { workspaceContextPort } from "../capabilities";
import {
  bindPort,
  createPortToken,
  defineAppModule,
  type AppModule,
} from "../index";
import { managedAgentsPortTokens } from "../managed-agents";

export const deploymentRunStorePort = createPortToken<DeploymentRunStore>(
  "managed-agents.store.deployment-runs",
);

export function deploymentRunsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:deployment-runs",
    provides: [managedAgentsPortTokens.deploymentRuns],
    requires: [workspaceContextPort, deploymentRunStorePort],
    setup({ port }) {
      return {
        ports: [bindPort(
          managedAgentsPortTokens.deploymentRuns,
          new DeploymentRunsApplicationService({
            workspaceId: port(workspaceContextPort).workspaceId,
            store: port(deploymentRunStorePort),
          }),
        )],
      };
    },
  });
}
