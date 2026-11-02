import { expect, it } from "vitest";
import { configToForm, mergeFormIntoConfig } from "./agentFormCodec";

it("preserves a pinned predefined agent and inline policy on an unrelated edit", () => {
  const multiagent = { type: "multiagent_20261001", advisor: { type: "disabled" }, workflows: { type: "disabled" }, subagents: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [{ type: "agent", id: "agent_child", version: 7 }] } };
  const base = { name: "Parent", model: "model-parent", multiagent };
  const form = configToForm(base);
  expect(form.callableAgents).toEqual([{ type: "agent", id: "agent_child", version: 7 }]);
  expect(mergeFormIntoConfig({ ...form, name: "Renamed" }, base, { forUpdate: true }).multiagent).toEqual(multiagent);
});
