import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { RuntimeSkillCache, type MaterializedSkill, type SkillBinding } from "@open-managed-agents/acp-runtime/skill-cache";
import { safeSkillArchivePath } from "@open-managed-agents/acp-runtime/skill-package";
import { paths } from "./platform.js";

export type { SkillBinding, MaterializedSkill };

/** Uses the tenant PAT already held by the daemon; it never enters the bundle or cache. */
export async function materializeManagedSkills(input: {
  sessionDir: string;
  skills: SkillBinding[];
  apiUrl: string;
  tenantId: string;
  agentApiKey: string;
}): Promise<MaterializedSkill[]> {
  const base = input.apiUrl.replace(/\/$/, "");
  const get = async (path: string) => {
    const response = await fetch(`${base}/v1/skills/${path}`, {
      headers: { "x-api-key": input.agentApiKey, "anthropic-beta": "skills-2025-10-02" },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Managed skill request failed (${response.status})`);
    return response;
  };
  return new RuntimeSkillCache({ sessionsRoot: paths().sessionsDir }).materialize({
    sessionDir: input.sessionDir,
    skills: input.skills,
    source: {
      scope: `${base}\n${input.tenantId}`,
      async resolveVersion(skill) {
        const meta = await (await get(encodeURIComponent(skill.skill_id))).json() as { latest_version_id?: string };
        if (!meta.latest_version_id) throw new Error(`Skill ${skill.skill_id} has no latest version`);
        return meta.latest_version_id;
      },
      async download(id, version) {
        const response = await get(`${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/content`);
        const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
        return Object.entries(archive).filter(([path]) => !path.endsWith("/"))
          .map(([path, content]) => ({ path: safeSkillArchivePath(path), content }));
      },
    },
  });
}

/** Both generic instructions and native discovery point at the same immutable packages. */
export async function configureManagedSkills(
  sessionDir: string, agentId: string, skills: MaterializedSkill[], claudeConfigDir?: string,
): Promise<Record<string, string>> {
  if (skills.length === 0) return {};
  const cache = new RuntimeSkillCache({ sessionsRoot: paths().sessionsDir });
  for (const skill of skills) {
    if (agentId === "claude-acp" && claudeConfigDir) {
      // CMA ZIPs include one named package directory. Claude expects SKILL.md
      // directly beneath the discoverable skill link, not another directory down.
      const packageRoot = dirname(join(skill.cachePath, skill.manifests[0]));
      await cache.link(packageRoot, join(claudeConfigDir, "skills", skill.skill_id));
    }
    // OpenCode discovers prompt agents as .md files, not skill package trees.
    // Its managed instructions use the generic skills directory, preserving all attachments.
  }
  return { OPENMA_SKILLS_DIR: join(sessionDir, "skills") };
}

export function managedSkillInstructions(skills: MaterializedSkill[]): string {
  return skills.length === 0 ? "" : "\n## Managed skills\n\nRead the relevant SKILL.md before using a skill. Paths are pinned for this Session.\n"
    + skills.flatMap((s) => s.manifests.map((path) => `- ${s.skill_id}@${s.version}: ${join(s.linkPath, path)}`)).join("\n") + "\n";
}
