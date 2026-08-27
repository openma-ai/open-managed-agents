import type {
  SessionThreadEventsApplicationPort,
  SessionThreadsApplicationPort,
} from "../src/index";

export function makeSessionThreadsPort(
  overrides: Partial<SessionThreadsApplicationPort>,
): SessionThreadsApplicationPort {
  return {
    listSessionThreads: async () => {
      throw new Error("unexpected listSessionThreads application port call");
    },
    retrieveSessionThread: async () => {
      throw new Error("unexpected retrieveSessionThread application port call");
    },
    archiveSessionThread: async () => {
      throw new Error("unexpected archiveSessionThread application port call");
    },
    ...overrides,
  };
}

export function makeSessionThreadEventsPort(
  overrides: Partial<SessionThreadEventsApplicationPort>,
): SessionThreadEventsApplicationPort {
  return {
    listSessionThreadEvents: async () => {
      throw new Error("unexpected listSessionThreadEvents application port call");
    },
    streamSessionThreadEvents: async () => {
      throw new Error("unexpected streamSessionThreadEvents application port call");
    },
    ...overrides,
  };
}
