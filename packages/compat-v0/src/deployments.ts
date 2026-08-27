import type { DeploymentStore } from "@open-managed-agents/deployment-store";
import type { DeploymentsApplicationServiceDependencies } from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import { deploymentStorePort } from "@open-managed-agents/app/modules/deployments";

/** The structural shape implemented by v0 Deployment persistence. */
export type V0DeploymentPersistence = DeploymentStore;

export type V0DeploymentsApplicationServiceDependencies = Omit<
  DeploymentsApplicationServiceDependencies,
  "store"
> & {
  persistence: V0DeploymentPersistence;
};

export function deploymentStoreFromV0(
  persistence: V0DeploymentPersistence,
): DeploymentStore {
  return persistence;
}

export function deploymentsDependenciesFromV0(
  dependencies: V0DeploymentsApplicationServiceDependencies,
): DeploymentsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: deploymentStoreFromV0(persistence) };
}

export function v0DeploymentPersistenceModule(
  persistence: V0DeploymentPersistence,
): AppModule {
  return providePort(
    deploymentStorePort,
    deploymentStoreFromV0(persistence),
    { name: "compat-v0:deployment-persistence" },
  );
}
