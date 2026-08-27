import type { SessionResourceStore } from "@open-managed-agents/session-resource-store";
import type {
  SessionResourcesApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import {
  sessionResourceStorePort,
} from "@open-managed-agents/app/modules/session-resources";

/** The structural Session Resource persistence shape exposed by v0. */
export type V0SessionResourcePersistence = SessionResourceStore;

export type V0SessionResourcesApplicationServiceDependencies = Omit<
  SessionResourcesApplicationServiceDependencies,
  "store"
> & {
  persistence: V0SessionResourcePersistence;
};

export function sessionResourceStoreFromV0(
  persistence: V0SessionResourcePersistence,
): SessionResourceStore {
  return persistence;
}

export function sessionResourcesDependenciesFromV0(
  dependencies: V0SessionResourcesApplicationServiceDependencies,
): SessionResourcesApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: sessionResourceStoreFromV0(persistence) };
}

export function v0SessionResourcePersistenceModule(
  persistence: V0SessionResourcePersistence,
): AppModule {
  return providePort(
    sessionResourceStorePort,
    sessionResourceStoreFromV0(persistence),
    { name: "compat-v0:session-resource-persistence" },
  );
}
