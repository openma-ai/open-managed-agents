import type { RuntimeAgentConfig as AgentConfig } from "@open-managed-agents/api-types";
import { resolveSkills, getSkillFilesFromManagedSource, type ManagedSkillVersionSource, type Skill, type SkillFilesResult } from "../harness/skills";

export async function resolveRuntimeSkillFiles(
  agent: Pick<AgentConfig, "skills">,
  managedSource?: ManagedSkillVersionSource,
  legacySource?: () => Promise<SkillFilesResult[]>,
): Promise<SkillFilesResult[]> {
  if (!agent.skills?.length) return [];
  if (managedSource) return getSkillFilesFromManagedSource(agent.skills, managedSource);
  if (legacySource) return legacySource();
  if (agent.skills.some(skill => skill.type === "custom")) throw new Error("Custom skills require a configured source");
  return [];
}

export async function resolveSubagentSkillReminders(
  agent: AgentConfig,
  customSkills?: () => Promise<Skill[]>,
  resolvedFiles?: SkillFilesResult[],
): Promise<Array<{ source: string; text: string }>> {
  const managedSkills = resolvedFiles?.map(result => {
    const manifest = result.files.find(file => file.filename === "SKILL.md")
      ?? result.files.find(file => file.filename.endsWith("/SKILL.md"));
    if (!manifest) throw new Error(`Skill ${result.skillId} has no SKILL.md`);
    return { id: result.skillId, name: result.skillName, system_prompt_addition: new TextDecoder().decode(manifest.bytes) };
  });
  const skills = [...resolveSkills(agent.skills ?? []), ...(managedSkills ?? (customSkills ? await customSkills() : []))];
  return skills.filter(skill => skill.system_prompt_addition).map(skill => ({
    source: `skill:${skill.id}`, text: skill.system_prompt_addition,
  }));
}

export function assertRuntimeAgentSnapshot(value: unknown, child = false): asserts value is AgentConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid runtime agent snapshot");
  const agent = value as Record<string, unknown>;
  const model = agent.model;
  if (typeof agent.id !== "string" || typeof agent.name !== "string" ||
      !(typeof model === "string" ? model.length > 0 : model && typeof model === "object" && typeof (model as Record<string, unknown>).id === "string" && (model as Record<string, unknown>).id !== "") ||
      typeof agent.system !== "string" || !Array.isArray(agent.tools) ||
      !Number.isInteger(agent.version) || Number(agent.version) < 1 ||
      (child && (!Array.isArray(agent.mcp_servers) || !Array.isArray(agent.skills)))) {
    throw new Error("Incomplete runtime agent snapshot");
  }
  if (agent.multiagent !== undefined) {
    const config = agent.multiagent as Record<string, any>;
    if (!config || config.type !== "multiagent_20261001" || config.advisor?.type !== "disabled" || config.workflows?.type !== "disabled" || !config.subagents || !["enabled", "disabled"].includes(config.subagents.type)) throw new Error("Invalid multiagent snapshot");
    if (config.subagents.type === "enabled") {
      if (!["enabled", "disabled"].includes(config.subagents.inline_agents?.type)) throw new Error("Invalid inline policy snapshot");
      if (!Array.isArray(config.subagents.predefined_agents)) throw new Error("Invalid roster snapshot");
      for (const member of config.subagents.predefined_agents) assertRuntimeAgentSnapshot(member, true);
    }
  }
}

/** Restore a lane from its recorded agent id, never from the primary agent implicitly. */
export function resolveThreadAgentSnapshot(parent: AgentConfig, childAgentId: string): AgentConfig {
  return resolvePinnedSubagent(parent, childAgentId);
}

/** Resolve solely from the Session snapshot, never a mutable agent registry. */
export function resolvePinnedSubagent(parent: AgentConfig, agentId: string): AgentConfig {
  assertRuntimeAgentSnapshot(parent);
  const policy = parent.multiagent?.subagents;
  if (policy?.type !== "enabled") throw new Error("Subagents are disabled");
  const selected = agentId === "general"
    ? policy.inline_agents.type === "enabled" ? parent : undefined
    : policy.predefined_agents.find(member => member.id === agentId);
  if (!selected) throw new Error("Subagent is not in the enabled Session roster");
  const copy: AgentConfig = structuredClone(selected);
  const { multiagent: _multiagent, callable_agents: _legacy, ...agent } = copy;
  return { ...agent, enable_general_subagent: false };
}
