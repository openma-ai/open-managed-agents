import type { EnvironmentStore } from "@open-managed-agents/environment-store";
import type {
  EnvironmentsApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import {
  environmentStorePort,
} from "@open-managed-agents/app/modules/environments";

/** The structural shape implemented by the v0 Environment persistence. */
export type V0EnvironmentPersistence = EnvironmentStore;

export type V0EnvironmentsApplicationServiceDependencies = Omit<
  EnvironmentsApplicationServiceDependencies,
  "store"
> & {
  persistence: V0EnvironmentPersistence;
};

export function environmentStoreFromV0(
  persistence: V0EnvironmentPersistence,
): EnvironmentStore {
  return persistence;
}

export function environmentsDependenciesFromV0(
  dependencies: V0EnvironmentsApplicationServiceDependencies,
): EnvironmentsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: environmentStoreFromV0(persistence) };
}

export function v0EnvironmentPersistenceModule(
  persistence: V0EnvironmentPersistence,
): AppModule {
  return providePort(
    environmentStorePort,
    environmentStoreFromV0(persistence),
    { name: "compat-v0:environment-persistence" },
  );
}
