import type { MemoryVersionActor } from "@open-managed-agents/domain/memories";
import {
  MemoriesApplicationService,
  MemoryVersionsApplicationService,
  type MemoryContentDescriptorPort,
  type MemoryStoreForMemorySourcePort,
} from "@open-managed-agents/managed-agents-application";
import type { MemoryDocumentStore } from "@open-managed-agents/memory-document-store";

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

export const memoryDocumentStorePort = createPortToken<MemoryDocumentStore>(
  "managed-agents.store.memory-documents",
);

export const memoryStoreForMemorySourcePort =
  createPortToken<MemoryStoreForMemorySourcePort>(
    "managed-agents.outbound.memories.memory-store-source",
  );

export const memoryContentDescriptorPort =
  createPortToken<MemoryContentDescriptorPort>(
    "managed-agents.outbound.memories.content-descriptor",
  );

export const memoryVersionActorPort = createPortToken<MemoryVersionActor>(
  "managed-agents.context.memory-version-actor",
);

export function memoriesModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:memories",
    provides: [managedAgentsPortTokens.memories],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      memoryDocumentStorePort,
      memoryStoreForMemorySourcePort,
      memoryContentDescriptorPort,
      memoryVersionActorPort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.memories,
          new MemoriesApplicationService({
            workspaceId: workspace.workspaceId,
            store: port(memoryDocumentStorePort),
            memoryStores: port(memoryStoreForMemorySourcePort),
            content: port(memoryContentDescriptorPort),
            actor: port(memoryVersionActorPort),
            clock: port(clockPort),
            ids: {
              nextMemoryId: () => ids.next("memory"),
              nextMemoryVersionId: () => ids.next("memory-version"),
            },
          }),
        )],
      };
    },
  });
}

export function memoryVersionsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:memory-versions",
    provides: [managedAgentsPortTokens.memoryVersions],
    requires: [
      workspaceContextPort,
      clockPort,
      memoryDocumentStorePort,
      memoryVersionActorPort,
    ],
    setup({ port }) {
      return {
        ports: [bindPort(
          managedAgentsPortTokens.memoryVersions,
          new MemoryVersionsApplicationService({
            workspaceId: port(workspaceContextPort).workspaceId,
            store: port(memoryDocumentStorePort),
            actor: port(memoryVersionActorPort),
            clock: port(clockPort),
          }),
        )],
      };
    },
  });
}
