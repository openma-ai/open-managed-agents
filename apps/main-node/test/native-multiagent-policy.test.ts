import { describe, expect, it } from "vitest";
import type { Session } from "@open-managed-agents/managed-agents-application";
import { nodeOpenAISubagentPolicy } from "../../../packages/control-plane-node/src/openai-subagents";
import { resolveManagedSubagentSession } from "../../../packages/control-plane-node/src/lib/node-managed-subagents";

const parent = {
  id: "session", metadata: {}, environmentId: "env", vaultIds: ["vault"],
  agent: { id: "parent", version: 1, name: "Parent", description: null,
    model: { id: "parent-model" }, system: "Parent system", tools: [{ type: "custom", name: "inspect", description: "Inspect", inputSchema: {} }], skills: [{ type: "custom", skillId: "skill", version: "2" }], mcpServers: [{ type: "url", name: "docs", url: "https://docs.test" }],
    multiagent: { type: "multiagent_20261001", advisor: { type: "disabled" },
      subagents: { type: "enabled", inlineAgents: { type: "enabled" }, predefinedAgents: [] } } },
} as unknown as Session;

describe("native multiagent policy and pinned resolution", () => {
  it("enables an inline-only session", async () => {
    expect(await nodeOpenAISubagentPolicy(parent, {} as never)).toMatchObject({ enabled: true });
  });
  it("inherits parent capabilities and appends inline instructions without delegation", () => {
    const child = resolveManagedSubagentSession(parent, { name: "Worker", instructions: "Find evidence" });
    expect(child.agent).toMatchObject({ name: "Worker", model: { id: "parent-model" },
      system: "Parent system\n\nFind evidence", tools: [{ type: "custom", name: "inspect" }], skills: [{ skillId: "skill", version: "2" }], mcpServers: [{ name: "docs", url: "https://docs.test" }], multiagent: null });
    expect(child.environmentId).toBe("env");
    expect(child.vaultIds).toEqual(["vault"]);
  });
  it("uses the pinned predefined model and rejects an unlisted agent", () => {
    const configured = structuredClone(parent);
    configured.agent.multiagent!.subagents = { type: "enabled", inlineAgents: { type: "disabled" },
      predefinedAgents: [{ ...parent.agent, type: "agent", id: "worker", name: "Pinned", model: { id: "child-model" }, system: "Child system", version: 2 } as never] };
    expect(resolveManagedSubagentSession(configured, { agentId: "worker" }).agent).toMatchObject({
      id: "worker", version: 2, model: { id: "child-model" }, system: "Child system", multiagent: null });
    expect(() => resolveManagedSubagentSession(configured, {})).toThrow(/inline/i);
    expect(() => resolveManagedSubagentSession(configured, { agentId: "missing" })).toThrow(/roster/i);
  });
});
