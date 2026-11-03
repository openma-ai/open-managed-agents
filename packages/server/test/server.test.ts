import { describe, expect, it } from "vitest";

import {
  admitAllSessionCreates,
  admitAllSessionWork,
  createApp,
  createNodePlatform,
  managedAgentsPortTokens,
  nodeDefaults,
  providePort,
} from "../src/index";
import {
  agentStorePort,
  deploymentSessionLauncherPort,
  sessionCreateAdmissionPort,
  sessionDeploymentLauncherPort,
  sessionWorkAdmissionPort,
} from "../src/modules";
import { KeyValueAgentStore, type KeyValue } from "./fixtures/kv-agent-store";

function mapKeyValue(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => { data.set(key, value); },
    delete: async (key) => { data.delete(key); },
    keys: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)),
  };
}

describe("@openma/server", () => {
  it("starts a Node control plane from nodeDefaults() with a custom store", async () => {
    const kv = mapKeyValue();
    const app = createApp({
      modules: nodeDefaults({
        workspaceId: "workspace_1",
        stores: { agents: new KeyValueAgentStore(kv) },
      }),
    });
    await app.start();

    const agents = app.port(managedAgentsPortTokens.agents);
    const created = await agents.createAgent({ name: "Custom store", model: "claude-sonnet-4-6" });
    expect(created).toMatchObject({ type: "created", agent: { name: "Custom store", version: 1 } });
    if (created.type !== "created") throw new Error("not created");

    const updated = await agents.updateAgent({
      agentId: created.agent.id,
      expectedVersion: 1,
      name: "Renamed",
    });
    expect(updated).toMatchObject({ type: "updated", agent: { name: "Renamed", version: 2 } });
    await expect(agents.listAgentVersions({ agentId: created.agent.id })).resolves.toMatchObject({
      type: "page",
      page: { agents: [{ version: 2 }, { version: 1 }] },
    });
    expect([...kv.data.keys()].some((key) => key.startsWith("agent:workspace_1:"))).toBe(true);

    await app.stop();
    expect(app.status).toBe("stopped");
  });

  it("binds admit-all admission hooks unless a hook is passed", async () => {
    const app = createApp({ modules: nodeDefaults({ workspaceId: "workspace_1" }) });
    const input = { workspaceId: "workspace_1", agentId: "a", environmentId: "e", isLocalRuntime: false };
    await expect(app.port(sessionCreateAdmissionPort).admit(input)).resolves.toEqual({ type: "admitted" });
    expect(app.port(sessionWorkAdmissionPort)).toBe(admitAllSessionWork);
    await expect(admitAllSessionCreates.admit(input)).resolves.toEqual({ type: "admitted" });
  });

  it("lets a module replace a default Port and enables a feature with its own adapter", () => {
    const store = new KeyValueAgentStore(mapKeyValue());
    const app = createNodePlatform({
      features: { preset: "none", agents: true },
      stores: { agents: store },
      modules: () => [providePort(
        // An extra Port, the way a non-default feature receives its adapters.
        deploymentSessionLauncherPort,
        { launch: async () => ({ type: "not_found" as const }) } as never,
      )],
    }).app({ workspaceId: "workspace_2" });

    expect(app.port(agentStorePort)).toBe(store);
    expect(() => app.port(managedAgentsPortTokens.vaults)).toThrowError(
      expect.objectContaining({ code: "missing_port" }),
    );
    expect(sessionDeploymentLauncherPort).not.toBe(deploymentSessionLauncherPort);
  });
});
