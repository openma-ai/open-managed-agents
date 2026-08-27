import {
  AgentsApplicationService,
} from "@open-managed-agents/managed-agents-application";
import type { AgentStore } from "@open-managed-agents/agent-store";

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

export const agentStorePort = createPortToken<AgentStore>(
  "managed-agents.store.agents",
);

export function agentsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:agents",
    provides: [managedAgentsPortTokens.agents],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      agentStorePort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const clock = port(clockPort);
      const ids = port(idGeneratorPort);
      const store = port(agentStorePort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.agents,
          new AgentsApplicationService({
            workspaceId: workspace.workspaceId,
            clock,
            store,
            ids: { nextAgentId: () => ids.next("agent") },
          }),
        )],
      };
    },
  });
}
