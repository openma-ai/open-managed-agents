import {
  UserProfilesApplicationService,
  type UserProfileEnrollmentIssuerPort,
} from "@open-managed-agents/managed-agents-application";
import type { UserProfileStore } from "@open-managed-agents/user-profile-store";

import {
  clockPort,
  idGeneratorPort,
  workspaceContextPort,
} from "../capabilities";
import {
  bindPort,
  createPortToken,
  defineAppModule,
  type AppModule,
} from "../index";
import { managedAgentsPortTokens } from "../managed-agents";

export const userProfileStorePort = createPortToken<UserProfileStore>(
  "managed-agents.store.user-profiles",
);

export const userProfileEnrollmentIssuerPort =
  createPortToken<UserProfileEnrollmentIssuerPort>(
    "managed-agents.outbound.user-profiles.enrollment-issuer",
  );

export function userProfilesModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:user-profiles",
    provides: [managedAgentsPortTokens.userProfiles],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      userProfileStorePort,
      userProfileEnrollmentIssuerPort,
    ],
    setup({ port }) {
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.userProfiles,
          new UserProfilesApplicationService({
            workspaceId: port(workspaceContextPort).workspaceId,
            store: port(userProfileStorePort),
            enrollment: port(userProfileEnrollmentIssuerPort),
            clock: port(clockPort),
            ids: {
              nextUserProfileId: () => ids.next("user-profile"),
            },
          }),
        )],
      };
    },
  });
}
