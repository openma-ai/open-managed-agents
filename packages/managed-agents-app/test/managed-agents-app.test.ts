import { describe, expect, it } from "vitest";

import { providePort, type PortToken } from "../src/index";
import {
  createManagedAgentsApp,
  managedAgentsPortTokens,
} from "../src/managed-agents";

const expectedPortNames = [
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
] as const;

describe("Managed Agents app composition", () => {
  it("requires every API-facing application Port and exposes only the aggregate", async () => {
    expect(Object.keys(managedAgentsPortTokens)).toEqual(expectedPortNames);

    const values = Object.fromEntries(
      expectedPortNames.map((name) => [name, { adapter: name }]),
    );
    const modules = expectedPortNames.map((name) => providePort(
      managedAgentsPortTokens[name]! as PortToken<unknown>,
      values[name],
    ));
    const app = createManagedAgentsApp({ modules });

    expect(app.status).toBe("created");
    expect(app.ports).toEqual(values);
    await app.start();
    expect(app.status).toBe("started");
    await app.stop();
    expect(app.status).toBe("stopped");
  });

  it("fails before serving when one application Port is absent", () => {
    const modules = expectedPortNames
      .filter((name) => name !== "models")
      .map((name) => providePort(
        managedAgentsPortTokens[name]! as PortToken<unknown>,
        { adapter: name },
      ));

    expect(() => createManagedAgentsApp({ modules })).toThrowError(
      expect.objectContaining({ code: "missing_port" }),
    );
  });
});
