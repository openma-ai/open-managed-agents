import type { RuntimeAgentConfig as AgentConfig } from "@open-managed-agents/api-types";
import { resolveSkills, getSkillFilesFromManagedSource, type ManagedSkillVersionSource, type Skill, type SkillFilesResult } from "./skills";

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
