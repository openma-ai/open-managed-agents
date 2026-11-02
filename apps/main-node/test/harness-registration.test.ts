import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());

describe("harness composition initialization", () => {
  it("reports an unconfigured default without fabricating implementations", async () => {
    const { getHarnessCatalog, resolveHarness } = await import("@open-managed-agents/agent/harness/registry");
    expect(getHarnessCatalog()).toEqual({ object: "list", data: [], default_harness_id: null });
    expect(() => resolveHarness()).toThrow(/Unknown harness/);
  });

  it("keeps legacy default factory registration working after core module initialization", async () => {
    const { registerCoreHarnesses } = await import("@open-managed-agents/agent/harness/builtins");
    const { registerHarness, resolveHarness, getHarnessCatalog } = await import("@open-managed-agents/agent/harness/registry");
    registerCoreHarnesses();
    const custom = { run: async () => {} };
    registerHarness("default", () => custom);
    registerCoreHarnesses();
    expect(resolveHarness()).toBe(custom);
    expect(getHarnessCatalog().default_harness_id).toBe("default");
    expect(() => registerHarness("default", () => custom)).toThrow(/already registered/i);
  });

  it("never replaces a deployment-provided core id across repeated initialization", async () => {
    const { registerHarness, resolveHarness, getHarnessCatalog } = await import("@open-managed-agents/agent/harness/registry");
    const custom = { run: async () => {} };
    registerHarness({ id: "pi", label: "Deployment Pi", description: "Custom policy",
      execution: { placement: "sandbox" }, capabilities: { runtime_binding: true }, requirements: [] }, () => custom);
    const { registerCoreHarnesses } = await import("@open-managed-agents/agent/harness/builtins");
    registerCoreHarnesses();
    registerCoreHarnesses();
    expect(resolveHarness()).toBe(custom);
    expect(getHarnessCatalog().default_harness_id).toBe("pi");
    expect(getHarnessCatalog().data.find((entry) => entry.id === "pi")).toEqual({
      id: "pi", label: "Deployment Pi", description: "Custom policy",
      execution: { placement: "sandbox" }, capabilities: { runtime_binding: true }, requirements: [],
    });
  });

  it("does not list a shadowed legacy default factory as a separately selectable implementation", async () => {
    const { registerHarness, setDefaultHarness, getHarnessCatalog, resolveHarness } = await import("@open-managed-agents/agent/harness/registry");
    const legacy = { run: async () => {} };
    const selected = { run: async () => {} };
    registerHarness("default", () => legacy);
    registerHarness("selected", () => selected);
    setDefaultHarness("selected");
    expect(resolveHarness("default")).toBe(selected);
    expect(getHarnessCatalog().data.map(({ id }) => id)).toEqual(["selected"]);
  });

  it("declares only the existing core placements and required ACP configuration", async () => {
    const { registerCoreHarnesses } = await import("@open-managed-agents/agent/harness/builtins");
    const { getHarnessCatalog, resolveHarness } = await import("@open-managed-agents/agent/harness/registry");
    registerCoreHarnesses();
    expect(getHarnessCatalog().default_harness_id).toBe("pi");
    expect(getHarnessCatalog().data.map(({ id, execution, capabilities, requirements }) => ({ id, execution, capabilities, requirements }))).toEqual([
      { id: "pi", execution: { placement: "host" }, capabilities: { runtime_binding: false }, requirements: [] },
      { id: "ai-sdk", execution: { placement: "host" }, capabilities: { runtime_binding: false }, requirements: [] },
      { id: "acp-sandbox", execution: { placement: "sandbox" }, capabilities: { runtime_binding: false }, requirements: ["acp.agent.command|acp.agent.registry"] },
    ]);
    expect(resolveHarness().constructor.name).toBe("PiHarness");
  });

  it("rejects malformed descriptor values instead of leaking arbitrary objects", async () => {
    const { registerHarness, getHarnessCatalog } = await import("@open-managed-agents/agent/harness/registry");
    const base = { id: "invalid", label: "Invalid", description: "Public", execution: { placement: "host" as const },
      capabilities: { runtime_binding: false }, requirements: [] };
    for (const patch of [
      { execution: { placement: "invented-cloud" } },
      { capabilities: { runtime_binding: "yes" } },
      { requirements: [{ secret: "private" }] },
      { requirements: ["TOKEN=private"] },
      { requirements: ["acp.agent.command|"] },
      { requirements: ["acp.agent.command||acp.agent.registry"] },
    ]) {
      expect(() => registerHarness({ ...base, ...patch } as typeof base, () => ({ run: async () => {} }))).toThrow(/Invalid harness/);
    }
    expect(getHarnessCatalog().data).toEqual([]);
  });
});
