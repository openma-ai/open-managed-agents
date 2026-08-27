import type { MemoryStoreStore } from "@open-managed-agents/memory-store-store";
import type {
  MemoryStoresApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import { memoryStoreStorePort } from "@open-managed-agents/app/modules/memory-stores";

/** The structural shape implemented by v0 Memory Store persistence. */
export type V0MemoryStorePersistence = MemoryStoreStore;

export type V0MemoryStoresApplicationServiceDependencies = Omit<
  MemoryStoresApplicationServiceDependencies,
  "store"
> & {
  persistence: V0MemoryStorePersistence;
};

export function memoryStoreStoreFromV0(
  persistence: V0MemoryStorePersistence,
): MemoryStoreStore {
  return persistence;
}

export function memoryStoresDependenciesFromV0(
  dependencies: V0MemoryStoresApplicationServiceDependencies,
): MemoryStoresApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: memoryStoreStoreFromV0(persistence) };
}

export function v0MemoryStorePersistenceModule(
  persistence: V0MemoryStorePersistence,
): AppModule {
  return providePort(
    memoryStoreStorePort,
    memoryStoreStoreFromV0(persistence),
    { name: "compat-v0:memory-store-persistence" },
  );
}
