import type { EnvironmentStore } from "@open-managed-agents/environment-store";
import { EnvironmentsApplicationService } from "@open-managed-agents/managed-agents-application";

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

export const environmentStorePort = createPortToken<EnvironmentStore>(
  "managed-agents.store.environments",
);

export function environmentsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:environments",
    provides: [managedAgentsPortTokens.environments],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      environmentStorePort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const clock = port(clockPort);
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.environments,
          new EnvironmentsApplicationService({
            workspaceId: workspace.workspaceId,
            store: port(environmentStorePort),
            clock,
            ids: {
              nextEnvironmentId: () => ids.next("environment"),
            },
          }),
        )],
      };
    },
  });
}
