import { describe, expect, expectTypeOf, it } from "vitest";
import { OpenMA, type OpenMaAgentMultiagentParams, type OpenMaAgentUpdateParams, type OpenMaAgentMultiagent, type OpenMaMultiagent, type OpenMaSessionThreadAgent } from "../src/index.js";

const patches: OpenMaAgentUpdateParams[] = [
  {}, { multiagent: null },
  { multiagent: { type: "multiagent_20261001" } },
  { multiagent: { type: "multiagent_20261001", subagents: null } },
  { multiagent: { type: "multiagent_20261001", subagents: { type: "disabled" } } },
  { multiagent: { type: "multiagent_20261001", subagents: { type: "enabled" } } },
  { multiagent: { type: "multiagent_20261001", subagents: { type: "enabled", inline_agents: null } } },
  { multiagent: { type: "multiagent_20261001", subagents: { type: "enabled", predefined_agents: null } } },
  { multiagent: { type: "multiagent_20261001", subagents: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: ["agent_a", { type: "agent", id: "agent_b", version: 2 }, { type: "self" }] } } },
];

const threadAgent: OpenMaSessionThreadAgent = {
  id: "agent_child", type: "agent", name: "Child", version: 2,
  description: null, mcp_servers: [], model: { id: "claude-opus-5" },
  skills: [], system: null, tools: [],
};
const topology = {
  type: "multiagent_20261001", advisor: { type: "disabled" },
  subagents: { type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [{ id: "agent_child", type: "agent", version: 2 }] },
  workflows: { type: "disabled" },
} satisfies OpenMaAgentMultiagent;

function clientFor(body: unknown, requests: Request[]) {
  return new OpenMA({ apiKey: "test", baseURL: "https://openma.test", maxRetries: 0,
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  });
}

describe("multiagent contract", () => {
  it.each(patches)("preserves patch fields at the transport boundary: %j", async (patch) => {
    const requests: Request[] = [];
    const client = clientFor({ ...threadAgent, multiagent: topology, metadata: {}, archived_at: null, created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z" }, requests);
    const result = await client.beta.agents.update("agent_parent", patch);
    expect(await requests[0]!.json()).toEqual(patch);
    expect(requests[0]!.method).toBe("POST");
    expect(new URL(requests[0]!.url).pathname).toBe("/v1/agents/agent_parent");
    expectTypeOf(result.multiagent).toEqualTypeOf<OpenMaAgentMultiagent | null>();
  });

  it("retrieves resolved references without claiming they are coordinator rosters", async () => {
    const requests: Request[] = [];
    const client = clientFor({ ...threadAgent, multiagent: topology, metadata: {}, archived_at: null, created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z" }, requests);
    const agent = await client.beta.agents.retrieve("agent_parent", { version: 2 });
    expectTypeOf(agent.multiagent).toEqualTypeOf<OpenMaAgentMultiagent | null>();
    expect(agent.multiagent?.subagents).toEqual({ type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [{ id: "agent_child", type: "agent", version: 2 }] });
    expect(new URL(requests[0]!.url).searchParams.get("version")).toBe("2");
  });

  it("exposes pinned session subagent definitions rather than references", async () => {
    const client = clientFor({
      id: "session_parent", type: "session", agent: { ...threadAgent, multiagent: { ...topology, subagents: { type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [threadAgent] } } },
      archived_at: null, budget: null, created_at: "2026-10-22T00:00:00Z", environment_id: "env_test", metadata: {}, outcome_evaluations: [], resources: [], stats: {}, status: "idle", title: null, updated_at: "2026-10-22T00:00:00Z", usage: {}, vault_ids: [],
    }, []);
    const session = await client.beta.sessions.retrieve("session_parent");
    expectTypeOf(session.agent.multiagent).toEqualTypeOf<OpenMaMultiagent<OpenMaSessionThreadAgent> | null>();
    if (session.agent.multiagent?.subagents.type !== "enabled") throw new Error("Expected enabled subagents");
    expect(session.agent.multiagent.subagents.predefined_agents[0]?.model.id).toBe("claude-opus-5");
  });

  it.each(["advisor", "workflows"])("does not silently drop unsupported %s or swallow API errors", async (capability) => {
    let captured: Request | undefined;
    const client = new OpenMA({ apiKey: "test", baseURL: "https://openma.test", maxRetries: 0,
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Unsupported capability" } }), { status: 400, headers: { "content-type": "application/json" } });
      },
    });
    // JavaScript/untyped callers still receive the API rejection, never a silent downgrade.
    const multiagent = { type: "multiagent_20261001", [capability]: { type: "enabled" } } as OpenMaAgentMultiagentParams;
    await expect(client.beta.agents.update("agent_parent", { multiagent })).rejects.toMatchObject({ status: 400 });
    expect(await captured!.json()).toEqual({ multiagent: { type: "multiagent_20261001", [capability]: { type: "enabled" } } });
  });

  it("rejects unsupported capabilities and legacy topology at compile time", () => {
    // These checks are compiled by the package's tsconfig.test.json.
    // @ts-expect-error advisor enabled is not supported by the API runtime
    const advisor: OpenMaAgentMultiagentParams = { type: "multiagent_20261001", advisor: { type: "enabled" } };
    // @ts-expect-error workflows enabled is not supported by the API runtime
    const workflows: OpenMaAgentMultiagentParams = { type: "multiagent_20261001", workflows: { type: "enabled" } };
    // @ts-expect-error coordinator is a legacy storage shape, not the public contract
    const legacy: OpenMaAgentMultiagentParams = { type: "coordinator", agents: [] };
    expect([advisor, workflows, legacy]).toHaveLength(3);
  });
});
