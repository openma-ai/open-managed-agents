import {
  FilesApplicationService,
} from "@open-managed-agents/managed-agents-application";
import type { FileContentStore } from "@open-managed-agents/file-content-store";
import type { FileStore } from "@open-managed-agents/file-store";

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

export const fileStorePort = createPortToken<FileStore>(
  "managed-agents.store.files",
);

export const fileContentStorePort = createPortToken<FileContentStore>(
  "managed-agents.outbound.files.content",
);

export function filesModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:files",
    provides: [managedAgentsPortTokens.files],
    requires: [
      workspaceContextPort,
      clockPort,
      idGeneratorPort,
      fileStorePort,
      fileContentStorePort,
    ],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const ids = port(idGeneratorPort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.files,
          new FilesApplicationService({
            workspaceId: workspace.workspaceId,
            store: port(fileStorePort),
            content: port(fileContentStorePort),
            clock: port(clockPort),
            ids: { nextFileId: () => ids.next("file") },
          }),
        )],
      };
    },
  });
}
