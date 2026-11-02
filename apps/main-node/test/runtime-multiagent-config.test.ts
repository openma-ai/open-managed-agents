import { expect, it } from "vitest";
import type { RuntimeAgentConfig as AgentConfig } from "@open-managed-agents/api-types";
import { resolveRuntimeSkillFiles, resolveSubagentSkillReminders, resolvePinnedSubagent, resolveThreadAgentSnapshot, assertRuntimeAgentSnapshot } from "../../agent/src/runtime/multiagent";
import { buildTools } from "../../agent/src/harness/tools";
import { registerSkill, getSkillFilesFromManagedSource } from "../../agent/src/harness/skills";
import { zipSync, strToU8 } from "fflate";
it("assembles managed-only skill instructions from the resolved archive", async () => {
  const files = await getSkillFilesFromManagedSource([{ skill_id: "managed-child", type: "custom", version: "7" }], {
    resolveManagedSkillVersion: async () => ({ type: "found", name: "Managed child", version: "7", archive: zipSync({ "SKILL.md": strToU8("Use the pinned workflow." ) }) }),
  });
  expect(await resolveSubagentSkillReminders({ skills: [] } as unknown as AgentConfig, undefined, files)).toEqual([
    { source: "skill:managed-child", text: "Use the pinned workflow." },
  ]);
});
it("loads managed skills without KV for both initial and resumed turns", async () => {
  const agent = { skills: [{ skill_id: "managed", type: "custom", version: "7" }] } as AgentConfig;
  const source = { resolveManagedSkillVersion: async () => ({ type: "found" as const, name: "Managed", version: "7", archive: zipSync({ "SKILL.md": strToU8("Pinned instructions") }) }) };
  for (let turn = 0; turn < 2; turn++) {
    const files = await resolveRuntimeSkillFiles(agent, source);
    expect(await resolveSubagentSkillReminders(agent, undefined, files)).toEqual([{ source: "skill:managed", text: "Pinned instructions" }]);
  }
});
it("fails instead of dropping custom skills when no source is configured", async () => {
  await expect(resolveRuntimeSkillFiles({ skills: [{ skill_id: "missing", type: "custom", version: "1" }] } as AgentConfig)).rejects.toThrow(/source/i);
});
it("assembles inherited builtin skill instructions for child harnesses", async () => {
  registerSkill({ id: "child-skill", name: "Child skill", system_prompt_addition: "Follow the skill workflow" });
  expect(await resolveSubagentSkillReminders({ skills: [{ skill_id: "child-skill", type: "anthropic" }] } as AgentConfig)).toEqual([
    { source: "skill:child-skill", text: "Follow the skill workflow" },
  ]);
});
const parent = { id: "parent", name: "Parent", model: "parent-model", system: "Parent system", tools: [], version: 1, created_at: "now",
  multiagent: { type: "multiagent_20261001", advisor: { type: "disabled" }, workflows: { type: "disabled" }, subagents: {
    type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [{ type: "agent", id: "worker", name: "Worker", model: "child-model", system: "Child system", tools: [], mcp_servers: [], skills: [], version: 7, created_at: "then" }] } } } as AgentConfig;
it.each(["model", "system", "tools", "version", "mcp_servers", "skills"])("rejects a JSON child missing %s", (field) => {
  const snapshot = JSON.parse(JSON.stringify(parent));
  delete snapshot.multiagent.subagents.predefined_agents[0][field];
  expect(() => resolvePinnedSubagent(snapshot, "worker")).toThrow(/snapshot/i);
});
it.each(["advisor", "workflows"])("rejects unsupported runtime %s", (field) => {
  const snapshot = JSON.parse(JSON.stringify(parent));
  snapshot.multiagent[field] = { type: "enabled" };
  expect(() => assertRuntimeAgentSnapshot(snapshot)).toThrow(/snapshot/i);
});
it("rejects a missing inline policy in a runtime snapshot", () => {
  const snapshot = JSON.parse(JSON.stringify(parent));
  delete snapshot.multiagent.subagents.inline_agents;
  expect(() => assertRuntimeAgentSnapshot(snapshot)).toThrow(/snapshot/i);
});
it("rejects reference-only JSON children", () => {
  const snapshot = JSON.parse(JSON.stringify(parent));
  snapshot.multiagent.subagents.predefined_agents = [{ type: "agent", id: "worker", version: 7 }];
  expect(() => resolvePinnedSubagent(snapshot, "worker")).toThrow(/snapshot/i);
});
it("resolves only pinned children and inherits inline configuration without delegation", () => {
  expect(resolvePinnedSubagent(parent, "worker")).toMatchObject({ model: "child-model", version: 7 });
  expect(resolvePinnedSubagent(parent, "general")).toMatchObject({ model: "parent-model", system: "Parent system" });
  expect(resolvePinnedSubagent(parent, "general").multiagent).toBeUndefined();
  expect(() => resolvePinnedSubagent(parent, "unlisted")).toThrow(/roster/);
});
it("keeps restored child lanes pinned and unable to delegate", () => {
  expect(resolveThreadAgentSnapshot(parent, "worker")).toMatchObject({ model: "child-model", version: 7, enable_general_subagent: false });
  expect(resolveThreadAgentSnapshot(parent, "worker").multiagent).toBeUndefined();
  expect(resolveThreadAgentSnapshot(parent, "general").model).toBe("parent-model");
  expect(() => resolveThreadAgentSnapshot(parent, "missing")).toThrow();
});
it("rejects a reference-only roster at the primary harness boundary", () => {
  const snapshot = structuredClone(parent) as any;
  snapshot.multiagent.subagents.predefined_agents = [{ type: "agent", id: "worker", version: 7 }];
  expect(() => assertRuntimeAgentSnapshot(snapshot)).toThrow(/snapshot/i);
});
it("exposes executable inline and predefined tools without an Anthropic key", async () => {
  const tools = await buildTools(parent, {} as never, { delegateToAgent: async (id, task) => `${id}:${task}` });
  expect(tools.general_subagent).toBeDefined();
  expect(tools.call_agent_worker).toBeDefined();
  expect(await tools.general_subagent!.execute!({ task: "inspect" }, {} as never)).toBe("general:inspect");
});
