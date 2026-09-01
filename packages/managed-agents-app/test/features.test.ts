import { describe, expect, it } from "vitest";

import { createPortToken, providePort } from "../src/index";
import {
  managedAgentsFeatureModules,
  type ManagedAgentsFeature,
  type ManagedAgentsFeatures,
} from "../src/features";
import { managedAgentsPortTokens } from "../src/managed-agents";

const officialFeatures = [
  "agents",
  "credentials",
  "deploymentRuns",
  "deployments",
  "dreams",
  "environments",
  "environmentWork",
  "files",
  "memories",
  "memoryStores",
  "memoryVersions",
  "models",
  "sessionEvents",
  "sessionResources",
  "sessionThreadEvents",
  "sessionThreads",
  "sessions",
  "skillVersions",
  "skills",
  "tunnelCertificates",
  "tunnels",
  "userProfiles",
  "vaults",
] as const satisfies readonly ManagedAgentsFeature[];

describe("Managed Agents feature preset", () => {
  it.each(officialFeatures)("maps %s to its official application Port", (feature) => {
    const modules = managedAgentsFeatureModules({
      preset: "none",
      [feature]: true,
    } as ManagedAgentsFeatures);

    expect(modules).toHaveLength(1);
    expect(modules[0]!.provides).toContain(managedAgentsPortTokens[feature]);
  });

  it("defaults only the store-backed core that needs no runtime adapter", () => {
    const provided = managedAgentsFeatureModules(undefined)
      .flatMap((module) => module.provides)
      .filter((port) => Object.values(managedAgentsPortTokens).includes(port as never));

    expect(provided).toEqual([
      managedAgentsPortTokens.agents,
      managedAgentsPortTokens.deploymentRuns,
      managedAgentsPortTokens.environments,
      managedAgentsPortTokens.memoryStores,
      managedAgentsPortTokens.vaults,
    ]);
  });

  it("can disable the complete preset", () => {
    expect(managedAgentsFeatureModules(false)).toEqual([]);
  });

  it("rejects a replacement that does not provide the feature Port", () => {
    const unrelatedPort = createPortToken<{ ok: boolean }>("test.unrelated");

    expect(() => managedAgentsFeatureModules({
      agents: providePort(unrelatedPort, { ok: true }),
    })).toThrowError(expect.objectContaining({
      code: "invalid_module",
    }));
  });
});
