// CF Skill materialization results -> the shared resource facts contract.
// Memory facts come directly from mountSessionResources in SessionDO.
import {
  sessionSkillResourceFact,
  sessionSkillVersionRoot,
  type SessionSkillResourceFact,
} from "@open-managed-agents/runtime-resource-contract";

interface CfSkillFiles {
  skillId: string;
  skillName: string;
  requestedVersion: string;
  files: ReadonlyArray<{ filename: string }>;
}

/** Facts for the canonical copies mountSkillFiles writes at
 * `/oma/skills/<id>/<requested version>/<archive path>`. A Skill without a
 * SKILL.md has no advertised location. */
export function cfSkillResourceFacts(results: readonly CfSkillFiles[]): SessionSkillResourceFact[] {
  const facts: SessionSkillResourceFact[] = [];
  for (const result of results) {
    const manifest = result.files.find((file) => file.filename === "SKILL.md")
      ?? result.files.find((file) => file.filename.replaceAll("\\", "/").endsWith("/SKILL.md"));
    if (manifest === undefined) continue;
    facts.push(sessionSkillResourceFact({
      skillId: result.skillId,
      name: result.skillName,
      manifestPath: `${sessionSkillVersionRoot(result.skillId, result.requestedVersion)}/${manifest.filename.replaceAll("\\", "/")}`,
    }));
  }
  return facts;
}
