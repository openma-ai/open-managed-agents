import { providePort, type AppModule } from "@open-managed-agents/app";
import { modelCatalogSourcePort } from "@open-managed-agents/app/modules/models";
import type { Model } from "@open-managed-agents/managed-agents-application";

import { ConfiguredModelCatalogSource } from "./configured-model-catalog";

export function configuredModelsModule(models: Model[]): AppModule {
  return providePort(
    modelCatalogSourcePort,
    new ConfiguredModelCatalogSource(models),
    { name: "managed-agents:configured-models" },
  );
}
