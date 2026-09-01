import type { FileStore } from "@open-managed-agents/file-store";
import type {
  FilesApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import { fileStorePort } from "@open-managed-agents/app/modules/files";

/** The structural shape implemented by v0 File metadata persistence. */
export type V0FilePersistence = FileStore;

export type V0FilesApplicationServiceDependencies = Omit<
  FilesApplicationServiceDependencies,
  "store"
> & {
  persistence: V0FilePersistence;
};

export function fileStoreFromV0(
  persistence: V0FilePersistence,
): FileStore {
  return persistence;
}

export function filesDependenciesFromV0(
  dependencies: V0FilesApplicationServiceDependencies,
): FilesApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: fileStoreFromV0(persistence) };
}

export function v0FilePersistenceModule(
  persistence: V0FilePersistence,
): AppModule {
  return providePort(fileStorePort, fileStoreFromV0(persistence), {
    name: "compat-v0:file-persistence",
  });
}
