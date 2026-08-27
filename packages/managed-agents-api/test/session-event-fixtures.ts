import type { SessionEventsApplicationPort } from "../src/index";

export function makeSessionEventsPort(
  overrides: Partial<SessionEventsApplicationPort>,
): SessionEventsApplicationPort {
  return {
    sendSessionEvents: async () => {
      throw new Error("unexpected sendSessionEvents application port call");
    },
    listSessionEvents: async () => {
      throw new Error("unexpected listSessionEvents application port call");
    },
    streamSessionEvents: async () => {
      throw new Error("unexpected streamSessionEvents application port call");
    },
    ...overrides,
  };
}
