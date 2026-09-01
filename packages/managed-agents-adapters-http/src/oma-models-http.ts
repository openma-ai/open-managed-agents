import {
  bindPort,
  defineAppModule,
  type AppModule,
} from "@open-managed-agents/app";
import { httpClientPort } from "@open-managed-agents/app/capabilities";
import { openmaPortTokens } from "@open-managed-agents/app/openma";
import { OmaModelsApplicationService } from "@open-managed-agents/oma-models";

import { HttpProviderModelCatalog } from "./provider-model-catalog";

export function omaModelsHttpModule(): AppModule {
  return defineAppModule({
    name: "openma:oma-models-http",
    provides: [openmaPortTokens.omaModels],
    requires: [httpClientPort],
    setup({ port }) {
      const http = port(httpClientPort);
      const service = new OmaModelsApplicationService({
        catalog: new HttpProviderModelCatalog({
          fetch: (input, init) => http.fetch(input, init),
        }),
      });
      return {
        ports: [bindPort(openmaPortTokens.omaModels, service)],
      };
    },
  });
}
