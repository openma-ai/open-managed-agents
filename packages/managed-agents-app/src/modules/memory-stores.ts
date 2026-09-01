import {
  MemoryStoresApplicationService,
} from "@open-managed-agents/managed-agents-application";
import type { MemoryStoreStore } from "@open-managed-agents/memory-store-store";

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

export const memoryStoreStorePort = createPortToken<MemoryStoreStore>(
  "managed-agents.store.memory-stores",
);

export function memoryStoresModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:memory-stores",
    provides: [managedAgentsPortTokens.memoryStores],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      memoryStoreStorePort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.memoryStores,
          new MemoryStoresApplicationService({
            workspaceId: workspace.workspaceId,
            store: port(memoryStoreStorePort),
            clock: port(clockPort),
            ids: { nextMemoryStoreId: () => ids.next("memory_store") },
          }),
        )],
      };
    },
  });
}
