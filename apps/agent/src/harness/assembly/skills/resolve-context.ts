import type { HarnessContext } from "../../interface";
import type { SkillMountDescriptor } from "./types";

const SKILL_SOURCE_PREFIX = "skill:";

/** Skill mounts prepared by the platform (preferred). */
export function skillMountsFromContext(ctx: HarnessContext): SkillMountDescriptor[] {
  if (ctx.skillMounts?.length) return [...ctx.skillMounts];
  return legacyMountsFromReminders(ctx.platformReminders ?? []);
}

function legacyMountsFromReminders(
  reminders: ReadonlyArray<{ source: string; text: string }>,
): SkillMountDescriptor[] {
  const mounts: SkillMountDescriptor[] = [];
  for (const reminder of reminders) {
    if (!reminder.source.startsWith(SKILL_SOURCE_PREFIX)) continue;
    const skillId = reminder.source.slice(SKILL_SOURCE_PREFIX.length);
    const inline = /^<skill name="([^"]*)">\n([\s\S]*)\n<\/skill>$/u.exec(reminder.text.trim());
    if (inline) {
      mounts.push({
        skillId,
        name: inline[1] || skillId,
        description: "",
        mountRoot: `/workspace/.openma/skills/${encodeURIComponent(skillId)}/latest/`,
        body: inline[2],
        source: "custom",
      });
      continue;
    }
    const mountMatch = /mounted at (\S+)/u.exec(reminder.text);
    const mountRoot = mountMatch?.[1] ?? `/workspace/.openma/skills/${encodeURIComponent(skillId)}/latest/`;
    mounts.push({
      skillId,
      name: skillId,
      description: reminder.text,
      mountRoot,
      source: "custom",
    });
  }
  return mounts;
}
