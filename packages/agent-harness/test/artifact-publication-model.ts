import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
/** Offline real Pi loop: one completed sampling, publication happens afterwards. */
export function artifactPublicationModel() {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses([fauxAssistantMessage("PUBLICATION_FAILURE_DONE")]);
  const models = createModels(); models.setProvider(faux.provider);
  return { faux, models };
}
