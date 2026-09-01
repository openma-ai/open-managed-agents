import {
  SessionResourcesApplicationService,
  type SessionFileSourcePort,
} from "@open-managed-agents/managed-agents-application";
import type { SessionResourceStore } from "@open-managed-agents/session-resource-store";

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

export const sessionResourceStorePort =
  createPortToken<SessionResourceStore>(
    "managed-agents.outbound.session-resources.store",
  );

/** @deprecated Use `sessionResourceStorePort`. */
export const sessionResourcePersistencePort = sessionResourceStorePort;

export const sessionResourceFileSourcePort =
  createPortToken<SessionFileSourcePort>(
    "managed-agents.outbound.session-resources.files",
  );

export function sessionResourcesModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:session-resources",
    provides: [managedAgentsPortTokens.sessionResources],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      sessionResourceStorePort,
      sessionResourceFileSourcePort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const clock = port(clockPort);
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.sessionResources,
          new SessionResourcesApplicationService({
            workspaceId: workspace.workspaceId,
            store: port(sessionResourceStorePort),
            files: port(sessionResourceFileSourcePort),
            clock,
            ids: { nextResourceId: () => ids.next("session-resource") },
          }),
        )],
      };
    },
  });
}
