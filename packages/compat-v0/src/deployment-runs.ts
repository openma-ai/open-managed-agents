import type { DeploymentRunStore } from "@open-managed-agents/deployment-run-store";
import type { DeploymentRunsApplicationServiceDependencies } from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import { deploymentRunStorePort } from "@open-managed-agents/app/modules/deployment-runs";

/** The structural shape implemented by v0 Deployment Run persistence. */
export type V0DeploymentRunPersistence = DeploymentRunStore;

export type V0DeploymentRunsApplicationServiceDependencies = Omit<
  DeploymentRunsApplicationServiceDependencies,
  "store"
> & {
  persistence: V0DeploymentRunPersistence;
};

export function deploymentRunStoreFromV0(
  persistence: V0DeploymentRunPersistence,
): DeploymentRunStore {
  return persistence;
}

export function deploymentRunsDependenciesFromV0(
  dependencies: V0DeploymentRunsApplicationServiceDependencies,
): DeploymentRunsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: deploymentRunStoreFromV0(persistence) };
}

export function v0DeploymentRunPersistenceModule(
  persistence: V0DeploymentRunPersistence,
): AppModule {
  return providePort(
    deploymentRunStorePort,
    deploymentRunStoreFromV0(persistence),
    { name: "compat-v0:deployment-run-persistence" },
  );
}
