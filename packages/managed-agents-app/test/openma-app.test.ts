import { describe, expect, it } from "vitest";

import { providePort, type AppModule, type PortToken } from "../src/index";
import { managedAgentsPortTokens } from "../src/managed-agents";
import * as openmaSdk from "../src/openma";

const openmaPortTokens = (
  openmaSdk as unknown as {
    openmaPortTokens: { omaModels: PortToken<unknown> };
  }
).openmaPortTokens;

const createOpenMAApp = (
  openmaSdk as unknown as {
    createOpenMAApp(options: { modules: readonly AppModule[] }): {
      ports: {
        managed: Record<string, unknown>;
        oma: { models: unknown };
      };
    };
  }
).createOpenMAApp;

describe("OpenMA app composition", () => {
  it("keeps official Managed Ports and OMA extension Ports in separate lanes", () => {
    const managedValues = Object.fromEntries(
      Object.keys(managedAgentsPortTokens).map((name) => [name, { lane: "managed", name }]),
    );
    const managedModules = Object.entries(managedAgentsPortTokens).map(
      ([name, token]) => providePort(token as PortToken<unknown>, managedValues[name]),
    );
    const omaModels = { lane: "oma", name: "provider-model-discovery" };

    const app = createOpenMAApp({
      modules: [
        ...managedModules,
        providePort(openmaPortTokens.omaModels, omaModels),
      ],
    });

    expect(app.ports.managed).toEqual(managedValues);
    expect(app.ports.oma.models).toBe(omaModels);
    expect(app.ports.managed.models).not.toBe(omaModels);
  });
});
