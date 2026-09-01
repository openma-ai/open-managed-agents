import type { UserProfileStore } from "@open-managed-agents/user-profile-store";
import type {
  UserProfilesApplicationServiceDependencies,
} from "@open-managed-agents/managed-agents-application";
import { providePort, type AppModule } from "@open-managed-agents/app";
import { userProfileStorePort } from "@open-managed-agents/app/modules/user-profiles";

/** The structural shape implemented by v0 User Profile persistence adapters. */
export type V0UserProfilePersistence = UserProfileStore;

export type V0UserProfilesApplicationServiceDependencies = Omit<
  UserProfilesApplicationServiceDependencies,
  "store"
> & { persistence: V0UserProfilePersistence };

export function userProfileStoreFromV0(
  persistence: V0UserProfilePersistence,
): UserProfileStore {
  return persistence;
}

export function userProfilesDependenciesFromV0(
  dependencies: V0UserProfilesApplicationServiceDependencies,
): UserProfilesApplicationServiceDependencies {
  const { persistence, ...rest } = dependencies;
  return { ...rest, store: userProfileStoreFromV0(persistence) };
}

export function v0UserProfilePersistenceModule(
  persistence: V0UserProfilePersistence,
): AppModule {
  return providePort(
    userProfileStorePort,
    userProfileStoreFromV0(persistence),
    { name: "compat-v0:user-profile-persistence" },
  );
}
