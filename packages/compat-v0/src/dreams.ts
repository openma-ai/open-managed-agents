import type { DreamStore } from "@open-managed-agents/dream-store";
import type {
  DreamExecutionApplicationServiceDependencies,
  DreamsApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import { dreamStorePort } from "@open-managed-agents/app/modules/dreams";

/** The structural shape implemented by v0 Dream persistence. */
export type V0DreamPersistence = DreamStore;

export type V0DreamsApplicationServiceDependencies = Omit<
  DreamsApplicationServiceDependencies,
  "store"
> & {
  persistence: V0DreamPersistence;
};

export type V0DreamExecutionApplicationServiceDependencies = Omit<
  DreamExecutionApplicationServiceDependencies,
  "store"
> & {
  persistence: V0DreamPersistence;
};

export function dreamStoreFromV0(
  persistence: V0DreamPersistence,
): DreamStore {
  return persistence;
}

export function dreamsDependenciesFromV0(
  dependencies: V0DreamsApplicationServiceDependencies,
): DreamsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: dreamStoreFromV0(persistence) };
}

export function dreamExecutionDependenciesFromV0(
  dependencies: V0DreamExecutionApplicationServiceDependencies,
): DreamExecutionApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: dreamStoreFromV0(persistence) };
}

export function v0DreamPersistenceModule(
  persistence: V0DreamPersistence,
): AppModule {
  return providePort(dreamStorePort, dreamStoreFromV0(persistence), {
    name: "compat-v0:dream-persistence",
  });
}
