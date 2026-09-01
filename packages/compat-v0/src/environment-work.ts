import type { EnvironmentWorkStore } from "@open-managed-agents/environment-work-store";
import type {
  EnvironmentWorkApplicationServiceDependencies,
  EnvironmentWorkEnqueuerServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import { environmentWorkStorePort } from "@open-managed-agents/app/modules/environment-work";

export type V0EnvironmentWorkPersistence = EnvironmentWorkStore;

export type V0EnvironmentWorkApplicationServiceDependencies = Omit<
  EnvironmentWorkApplicationServiceDependencies,
  "store"
> & { persistence: V0EnvironmentWorkPersistence };

export type V0EnvironmentWorkEnqueuerServiceDependencies = Omit<
  EnvironmentWorkEnqueuerServiceDependencies,
  "store"
> & { persistence: V0EnvironmentWorkPersistence };

export function environmentWorkStoreFromV0(
  persistence: V0EnvironmentWorkPersistence,
): EnvironmentWorkStore {
  return persistence;
}

export function environmentWorkDependenciesFromV0(
  dependencies: V0EnvironmentWorkApplicationServiceDependencies,
): EnvironmentWorkApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: environmentWorkStoreFromV0(persistence) };
}

export function environmentWorkEnqueuerDependenciesFromV0(
  dependencies: V0EnvironmentWorkEnqueuerServiceDependencies,
): EnvironmentWorkEnqueuerServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: environmentWorkStoreFromV0(persistence) };
}

export function v0EnvironmentWorkPersistenceModule(
  persistence: V0EnvironmentWorkPersistence,
): AppModule {
  return providePort(
    environmentWorkStorePort,
    environmentWorkStoreFromV0(persistence),
    { name: "compat-v0:environment-work-persistence" },
  );
}
