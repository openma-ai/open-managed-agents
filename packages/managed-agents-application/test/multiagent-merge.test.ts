import { describe, expect, it } from "vitest";
import { mergeMultiagent } from "../src/agents/multiagent-merge";

const stored = {
  type: "multiagent_20261001" as const,
  advisor: { type: "disabled" as const },
  subagents: {
    type: "enabled" as const,
    inlineAgents: { type: "disabled" as const },
    predefinedAgents: [{ type: "agent" as const, agentId: "agent_child", version: 2 }],
  },
  workflows: { type: "disabled" as const },
};

describe("multiagent defaults and recursive patch semantics", () => {
  it("rejects workflows enabled by the official default", () => {
    expect(mergeMultiagent({ type: "multiagent_20261001" })).toMatchObject({ type: "invalid_request", message: expect.stringContaining("workflows") });
    expect(mergeMultiagent({ type: "multiagent_20261001", workflows: null }, stored)).toMatchObject({ type: "invalid_request" });
  });

  it("preserves disabled workflows and pinned references when omitted", () => {
    expect(mergeMultiagent({ type: "multiagent_20261001", subagents: { type: "enabled" } }, stored)).toEqual({ type: "resolved", multiagent: stored });
  });

  it("restores subagent defaults on null and replaces lists", () => {
    expect(mergeMultiagent({ type: "multiagent_20261001", subagents: null }, stored)).toEqual({ type: "resolved", multiagent: { ...stored, subagents: { type: "enabled", inlineAgents: { type: "enabled" }, predefinedAgents: [] } } });
    expect(mergeMultiagent({ type: "multiagent_20261001", subagents: { type: "enabled", predefinedAgents: ["agent_new"] } }, stored)).toMatchObject({ type: "resolved", multiagent: { subagents: { inlineAgents: { type: "disabled" }, predefinedAgents: ["agent_new"] } } });
  });

  it("allows inline-only subagents, rejects an empty disabled roster, and rejects unsupported advisor", () => {
    expect(mergeMultiagent({ type: "multiagent_20261001", workflows: { type: "disabled" }, subagents: { type: "enabled", predefinedAgents: [] } })).toMatchObject({ type: "resolved", multiagent: { subagents: { type: "enabled", inlineAgents: { type: "enabled" }, predefinedAgents: [] } } });
    expect(mergeMultiagent({ type: "multiagent_20261001", workflows: { type: "disabled" }, subagents: { type: "enabled", inlineAgents: { type: "disabled" }, predefinedAgents: [] } })).toMatchObject({ type: "invalid_request" });
    expect(mergeMultiagent({ type: "multiagent_20261001", advisor: { type: "enabled", model: "advisor-model" } }, stored)).toMatchObject({ type: "invalid_request", message: expect.stringContaining("advisor") });
  });

  it("defaults advisor to disabled, subagents and inline agents to enabled", () => {
    expect(mergeMultiagent({ type: "multiagent_20261001", workflows: { type: "disabled" } })).toEqual({ type: "resolved", multiagent: { ...stored, subagents: { type: "enabled", inlineAgents: { type: "enabled" }, predefinedAgents: [] } } });
  });
});
