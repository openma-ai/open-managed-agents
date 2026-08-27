import type { MemoryDocumentStore } from "@open-managed-agents/memory-document-store";
import type {
  MemoriesApplicationServiceDependencies,
  MemoryVersionsApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import { memoryDocumentStorePort } from "@open-managed-agents/app/modules/memories";

/** The structural shape implemented by v0 Memory persistence adapters. */
export type V0MemoryPersistence = MemoryDocumentStore;

export type V0MemoriesApplicationServiceDependencies = Omit<
  MemoriesApplicationServiceDependencies,
  "store"
> & {
  persistence: V0MemoryPersistence;
};

export type V0MemoryVersionsApplicationServiceDependencies = Omit<
  MemoryVersionsApplicationServiceDependencies,
  "store"
> & {
  persistence: V0MemoryPersistence;
};

/** Preserves a v0 implementation while exposing the v1 Store Port name. */
export function memoryDocumentStoreFromV0(
  persistence: V0MemoryPersistence,
): MemoryDocumentStore {
  return persistence;
}

export function memoriesDependenciesFromV0(
  dependencies: V0MemoriesApplicationServiceDependencies,
): MemoriesApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: memoryDocumentStoreFromV0(persistence) };
}

export function memoryVersionsDependenciesFromV0(
  dependencies: V0MemoryVersionsApplicationServiceDependencies,
): MemoryVersionsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: memoryDocumentStoreFromV0(persistence) };
}

/** Installs v0 Memory persistence into the SDK-first application graph. */
export function v0MemoryPersistenceModule(
  persistence: V0MemoryPersistence,
): AppModule {
  return providePort(
    memoryDocumentStorePort,
    memoryDocumentStoreFromV0(persistence),
    { name: "compat-v0:memory-persistence" },
  );
}
