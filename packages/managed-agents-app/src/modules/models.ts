import {
  ModelsApplicationService,
  type ModelCatalogSourcePort,
} from "@open-managed-agents/managed-agents-application";

import { workspaceContextPort } from "../capabilities";
import {
  bindPort,
  createPortToken,
  defineAppModule,
  type AppModule,
} from "../index";
import { managedAgentsPortTokens } from "../managed-agents";

export const modelCatalogSourcePort = createPortToken<ModelCatalogSourcePort>(
  "managed-agents.outbound.model-catalog",
);

export function modelsModule(): AppModule {
  return defineAppModule({
    name: "managed-agents:models",
    provides: [managedAgentsPortTokens.models],
    requires: [workspaceContextPort, modelCatalogSourcePort],
    setup({ port }) {
      const workspace = port(workspaceContextPort);
      const catalog = port(modelCatalogSourcePort);
      return {
        ports: [bindPort(
          managedAgentsPortTokens.models,
          new ModelsApplicationService({
            workspaceId: workspace.workspaceId,
            catalog,
          }),
        )],
      };
    },
  });
}
