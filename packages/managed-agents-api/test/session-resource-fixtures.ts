import type { SessionResourcesApplicationPort } from "../src/index";

export function makeSessionResourcesPort(
  overrides: Partial<SessionResourcesApplicationPort>,
): SessionResourcesApplicationPort {
  return {
    listSessionResources: async () => {
      throw new Error("unexpected listSessionResources application port call");
    },
    addSessionFileResource: async () => {
      throw new Error("unexpected addSessionFileResource application port call");
    },
    retrieveSessionResource: async () => {
      throw new Error("unexpected retrieveSessionResource application port call");
    },
    updateSessionResource: async () => {
      throw new Error("unexpected updateSessionResource application port call");
    },
    deleteSessionResource: async () => {
      throw new Error("unexpected deleteSessionResource application port call");
    },
    ...overrides,
  };
}
