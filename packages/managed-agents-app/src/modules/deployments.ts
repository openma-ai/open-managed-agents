import type { DeploymentStore } from "@open-managed-agents/deployment-store";
import {
  DeploymentsApplicationService,
  type DeploymentAgentSourcePort,
  type DeploymentEnvironmentSourcePort,
  type DeploymentFileSourcePort,
  type DeploymentMemoryStoreSourcePort,
  type DeploymentSchedulePlannerPort,
  type DeploymentSessionLauncherPort,
  type DeploymentVaultSourcePort,
} from "@open-managed-agents/managed-agents-application";

import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../capabilities";
import {
  bindPort,
  createPortToken,
  defineAppModule,
  type AppModule,
} from "../index";
import { managedAgentsPortTokens } from "../managed-agents";
import { deploymentRunStorePort } from "./deployment-runs";

export const deploymentStorePort = createPortToken<DeploymentStore>(
  "managed-agents.store.deployments",
);
export const deploymentAgentSourcePort =
  createPortToken<DeploymentAgentSourcePort>(
    "managed-agents.outbound.deployments.agents",
  );
export const deploymentEnvironmentSourcePort =
  createPortToken<DeploymentEnvironmentSourcePort>(
    "managed-agents.outbound.deployments.environments",
  );
export const deploymentFileSourcePort =
  createPortToken<DeploymentFileSourcePort>(
    "managed-agents.outbound.deployments.files",
  );
export const deploymentMemoryStoreSourcePort =
  createPortToken<DeploymentMemoryStoreSourcePort>(
    "managed-agents.outbound.deployments.memory-stores",
  );
/** @deprecated Import deploymentRunStorePort from ./deployment-runs. */
export const deploymentRunPersistencePort = deploymentRunStorePort;
export const deploymentSchedulePlannerPort =
  createPortToken<DeploymentSchedulePlannerPort>(
    "managed-agents.outbound.deployments.schedules",
  );
export const deploymentSessionLauncherPort =
  createPortToken<DeploymentSessionLauncherPort>(
    "managed-agents.outbound.deployments.sessions",
  );
export const deploymentVaultSourcePort =
  createPortToken<DeploymentVaultSourcePort>(
    "managed-agents.outbound.deployments.vaults",
  );

export function deploymentsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:deployments",
    provides: [managedAgentsPortTokens.deployments],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      deploymentStorePort,
      deploymentAgentSourcePort,
      deploymentEnvironmentSourcePort,
      deploymentFileSourcePort,
      deploymentMemoryStoreSourcePort,
      deploymentRunStorePort,
      deploymentSchedulePlannerPort,
      deploymentSessionLauncherPort,
      deploymentVaultSourcePort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.deployments,
          new DeploymentsApplicationService({
            workspaceId: workspace.workspaceId,
            agents: port(deploymentAgentSourcePort),
            environments: port(deploymentEnvironmentSourcePort),
            files: port(deploymentFileSourcePort),
            memoryStores: port(deploymentMemoryStoreSourcePort),
            store: port(deploymentStorePort),
            runs: port(deploymentRunStorePort),
            schedules: port(deploymentSchedulePlannerPort),
            sessions: port(deploymentSessionLauncherPort),
            vaults: port(deploymentVaultSourcePort),
            clock: port(clockPort),
            ids: {
              nextDeploymentId: () => ids.next("deployment"),
              nextDeploymentRunId: () => ids.next("deployment-run"),
            },
          }),
        )],
      };
    },
  });
}
