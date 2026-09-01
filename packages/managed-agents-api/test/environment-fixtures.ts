import type { EnvironmentsApplicationPort } from "../src/index";

export function makeEnvironmentsPort(
  overrides: Partial<EnvironmentsApplicationPort>,
): EnvironmentsApplicationPort {
  return {
    createEnvironment: async () => {
      throw new Error("unexpected createEnvironment application port call");
    },
    retrieveEnvironment: async () => {
      throw new Error("unexpected retrieveEnvironment application port call");
    },
    updateEnvironment: async () => {
      throw new Error("unexpected updateEnvironment application port call");
    },
    listEnvironments: async () => {
      throw new Error("unexpected listEnvironments application port call");
    },
    deleteEnvironment: async () => {
      throw new Error("unexpected deleteEnvironment application port call");
    },
    archiveEnvironment: async () => {
      throw new Error("unexpected archiveEnvironment application port call");
    },
    ...overrides,
  };
}
