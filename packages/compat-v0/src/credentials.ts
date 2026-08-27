import type { CredentialStore } from "@open-managed-agents/credential-store";
import type {
  CredentialsApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import { credentialStorePort } from "@open-managed-agents/app/modules/credentials";

/** The structural shape implemented by v0 Credential persistence. */
export type V0CredentialPersistence = CredentialStore;

export type V0CredentialsApplicationServiceDependencies = Omit<
  CredentialsApplicationServiceDependencies,
  "store"
> & {
  persistence: V0CredentialPersistence;
};

export function credentialStoreFromV0(
  persistence: V0CredentialPersistence,
): CredentialStore {
  return persistence;
}

export function credentialsDependenciesFromV0(
  dependencies: V0CredentialsApplicationServiceDependencies,
): CredentialsApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: credentialStoreFromV0(persistence) };
}

export function v0CredentialPersistenceModule(
  persistence: V0CredentialPersistence,
): AppModule {
  return providePort(
    credentialStorePort,
    credentialStoreFromV0(persistence),
    { name: "compat-v0:credential-persistence" },
  );
}
