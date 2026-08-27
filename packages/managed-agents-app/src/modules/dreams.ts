import type { DreamStore } from "@open-managed-agents/dream-store";
import {
  DreamExecutionApplicationService,
  DreamsApplicationService,
  type DreamCuratorPort,
  type DreamExecutionApplicationPort,
  type DreamExecutionSchedulerPort,
  type DreamMemoryStoreSourcePort,
  type DreamMemoryWorkspacePort,
  type DreamSessionSourcePort,
} from "@open-managed-agents/managed-agents-application";

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

export const dreamStorePort = createPortToken<DreamStore>(
  "managed-agents.store.dreams",
);
export const dreamMemoryStoreSourcePort =
  createPortToken<DreamMemoryStoreSourcePort>(
    "managed-agents.outbound.dreams.memory-store-source",
  );
export const dreamSessionSourcePort = createPortToken<DreamSessionSourcePort>(
  "managed-agents.outbound.dreams.session-source",
);
export const dreamExecutionSchedulerPort =
  createPortToken<DreamExecutionSchedulerPort>(
    "managed-agents.outbound.dreams.execution-scheduler",
  );
export const dreamMemoryWorkspacePort =
  createPortToken<DreamMemoryWorkspacePort>(
    "managed-agents.outbound.dreams.memory-workspace",
  );
export const dreamCuratorPort = createPortToken<DreamCuratorPort>(
  "managed-agents.outbound.dreams.curator",
);
export const dreamExecutionPort =
  createPortToken<DreamExecutionApplicationPort>(
    "managed-agents.application.dream-execution",
  );

export function dreamExecutionModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:dream-execution",
    provides: [dreamExecutionPort],
    requires: [
      workspaceContextPort,
      clockPort,
      dreamStorePort,
      dreamMemoryWorkspacePort,
      dreamCuratorPort,
      dreamSessionSourcePort,
    ],
    setup({ port }) {
      return {
        ports: [bindPort(
          dreamExecutionPort,
          new DreamExecutionApplicationService({
            workspaceId: port(workspaceContextPort).workspaceId,
            store: port(dreamStorePort),
            memories: port(dreamMemoryWorkspacePort),
            curator: port(dreamCuratorPort),
            sessions: port(dreamSessionSourcePort),
            clock: port(clockPort),
          }),
        )],
      };
    },
  });
}

export function dreamsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:dreams",
    provides: [managedAgentsPortTokens.dreams],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      dreamStorePort,
      dreamMemoryStoreSourcePort,
      dreamSessionSourcePort,
      dreamExecutionSchedulerPort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.dreams,
          new DreamsApplicationService({
            workspaceId: workspace.workspaceId,
            store: port(dreamStorePort),
            memoryStores: port(dreamMemoryStoreSourcePort),
            sessions: port(dreamSessionSourcePort),
            execution: port(dreamExecutionSchedulerPort),
            clock: port(clockPort),
            ids: { nextDreamId: () => ids.next("dream") },
          }),
        )],
      };
    },
  });
}
