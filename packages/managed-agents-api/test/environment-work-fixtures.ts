import type {
  EnvironmentWorkApplicationPort,
  EnvironmentWorkView,
} from "../src/index";

export const environmentWorkView: EnvironmentWorkView = {
  id: "work_01",
  acknowledgedAt: "2026-08-26T09:10:01.000Z",
  createdAt: "2026-08-26T09:10:00.000Z",
  data: { type: "session", id: "session_01" },
  environmentId: "env_self_01",
  latestHeartbeatAt: "2026-08-26T09:10:02.000Z",
  metadata: { shard: "a" },
  secret: null,
  startedAt: "2026-08-26T09:10:01.000Z",
  state: "active",
  stopRequestedAt: null,
  stoppedAt: null,
};

export function makeEnvironmentWorkPort(
  overrides: Partial<EnvironmentWorkApplicationPort>,
): EnvironmentWorkApplicationPort {
  return {
    retrieveEnvironmentWork: async () => {
      throw new Error("unexpected retrieveEnvironmentWork application port call");
    },
    updateEnvironmentWork: async () => {
      throw new Error("unexpected updateEnvironmentWork application port call");
    },
    listEnvironmentWork: async () => {
      throw new Error("unexpected listEnvironmentWork application port call");
    },
    acknowledgeEnvironmentWork: async () => {
      throw new Error("unexpected acknowledgeEnvironmentWork application port call");
    },
    heartbeatEnvironmentWork: async () => {
      throw new Error("unexpected heartbeatEnvironmentWork application port call");
    },
    pollEnvironmentWork: async () => {
      throw new Error("unexpected pollEnvironmentWork application port call");
    },
    getEnvironmentWorkQueueStats: async () => {
      throw new Error("unexpected getEnvironmentWorkQueueStats application port call");
    },
    stopEnvironmentWork: async () => {
      throw new Error("unexpected stopEnvironmentWork application port call");
    },
    ...overrides,
  };
}
