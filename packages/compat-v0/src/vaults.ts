import type { VaultStore } from "@open-managed-agents/vault-store";
import type {
  VaultsApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import { vaultStorePort } from "@open-managed-agents/app/modules/vaults";

/** The structural shape implemented by v0 Vault persistence. */
export type V0VaultPersistence = VaultStore;

export type V0VaultsApplicationServiceDependencies = Omit<
  VaultsApplicationServiceDependencies,
  "store"
> & {
  persistence: V0VaultPersistence;
};

export function vaultStoreFromV0(
  persistence: V0VaultPersistence,
): VaultStore {
  return persistence;
}

export function vaultsDependenciesFromV0(
  dependencies: V0VaultsApplicationServiceDependencies,
): VaultsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: vaultStoreFromV0(persistence) };
}

export function v0VaultPersistenceModule(
  persistence: V0VaultPersistence,
): AppModule {
  return providePort(vaultStorePort, vaultStoreFromV0(persistence), {
    name: "compat-v0:vault-persistence",
  });
}
