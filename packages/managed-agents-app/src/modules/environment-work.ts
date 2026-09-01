import {
  EnvironmentWorkApplicationService,
  EnvironmentWorkEnqueuerService,
  type EnvironmentSessionWorkEnqueuerPort,
  type EnvironmentWorkAvailabilityWaiterPort,
  type EnvironmentWorkEnvironmentSourcePort,
  type EnvironmentWorkSessionCredentialIssuerPort,
} from "@open-managed-agents/managed-agents-application";
import type { EnvironmentWorkStore } from "@open-managed-agents/environment-work-store";

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

export const environmentWorkStorePort = createPortToken<EnvironmentWorkStore>(
  "managed-agents.store.environment-work",
);

export const environmentWorkEnvironmentSourcePort =
  createPortToken<EnvironmentWorkEnvironmentSourcePort>(
    "managed-agents.outbound.environment-work.environment-source",
  );

export const environmentWorkAvailabilityWaiterPort =
  createPortToken<EnvironmentWorkAvailabilityWaiterPort>(
    "managed-agents.outbound.environment-work.availability-waiter",
  );

export const environmentWorkSessionCredentialIssuerPort =
  createPortToken<EnvironmentWorkSessionCredentialIssuerPort>(
    "managed-agents.outbound.environment-work.session-credential-issuer",
  );

export const environmentSessionWorkEnqueuerPort =
  createPortToken<EnvironmentSessionWorkEnqueuerPort>(
    "managed-agents.application.environment-work-enqueuer",
  );

export function environmentWorkModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:environment-work",
    provides: [managedAgentsPortTokens.environmentWork],
    requires: [
      workspaceContextPort,
      clockPort,
      environmentWorkStorePort,
      environmentWorkEnvironmentSourcePort,
      environmentWorkAvailabilityWaiterPort,
    ],
    setup({ port }) {
      return {
        ports: [bindPort(
          managedAgentsPortTokens.environmentWork,
          new EnvironmentWorkApplicationService({
            workspaceId: port(workspaceContextPort).workspaceId,
            environments: port(environmentWorkEnvironmentSourcePort),
            store: port(environmentWorkStorePort),
            availability: port(environmentWorkAvailabilityWaiterPort),
            clock: port(clockPort),
          }),
        )],
      };
    },
  });
}

export function environmentWorkEnqueuerModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:environment-work-enqueuer",
    provides: [environmentSessionWorkEnqueuerPort],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      environmentWorkStorePort,
      environmentWorkSessionCredentialIssuerPort,
    ],
    setup({ port }) {
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          environmentSessionWorkEnqueuerPort,
          new EnvironmentWorkEnqueuerService({
            workspaceId: port(workspaceContextPort).workspaceId,
            store: port(environmentWorkStorePort),
            credentials: port(environmentWorkSessionCredentialIssuerPort),
            clock: port(clockPort),
            ids: { nextEnvironmentWorkId: () => ids.next("environment-work") },
          }),
        )],
      };
    },
  });
}
