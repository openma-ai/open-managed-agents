// CF SessionDO Session resource guidance. Evidence level: the real
// agent-harness mountSkillFiles and session-runtime memoryStoreMountTarget
// (the functions SessionDO warmup and sandbox provisioning call) against an
// in-memory recording sandbox. No container, no model inference.
import { describe, expect, it, vi } from "vitest";
import { composeSystemPrompt, mountSkillFiles } from "@open-managed-agents/agent-harness";
import { sessionResourceFacts, sessionResourceReminders } from "@open-managed-agents/runtime-resource-contract";
import { cfSkillResourceFacts } from "../src/runtime/session-resource-guidance";

const bytes = (value: string) => new TextEncoder().encode(value);

function recordingSandbox() {
  const written = new Map<string, Uint8Array>();
  return {
    written,
    exec: vi.fn(async () => ""),
    writeFileBytes: vi.fn(async (path: string, content: Uint8Array) => { written.set(path, content); return "ok"; }),
  };
}

describe("CF SessionDO resource guidance", () => {
  it("advertises the canonical Skill directory mountSkillFiles actually wrote, so relative script paths resolve", async () => {
    const manifest = bytes("---\nname: csv\n---\nRun `sh scripts/run.sh`.\n");
    const script = bytes("cat data/v.txt\n");
    const results = [
      { skillId: "skill_csv", skillName: "csv", requestedVersion: "latest", files: [
        { filename: "csv/SKILL.md", bytes: manifest },
        { filename: "csv/scripts/run.sh", bytes: script },
      ] },
      // A flat archive (SKILL.md at the root) and an id that needs encoding.
      { skillId: "skill flat", skillName: "flat", requestedVersion: "2", files: [{ filename: "SKILL.md", bytes: manifest }] },
      // No manifest: never advertised.
      { skillId: "skill_none", skillName: "none", requestedVersion: "1", files: [{ filename: "x.txt", bytes: bytes("x") }] },
    ];
    const sandbox = recordingSandbox();
    await mountSkillFiles(sandbox, results);
    const facts = cfSkillResourceFacts(results);
    expect(facts.map((fact) => fact.manifestPath)).toEqual([
      "/oma/skills/skill_csv/latest/csv/SKILL.md",
      "/oma/skills/skill%20flat/2/SKILL.md",
    ]);
    for (const fact of facts) expect(sandbox.written.get(fact.manifestPath)).toEqual(manifest);
    expect(sandbox.written.get(`${facts[0]!.directory}/scripts/run.sh`)).toEqual(script);

    const reminders = sessionResourceReminders(sessionResourceFacts({ skills: facts }));
    expect(reminders.map((r) => r.source)).toEqual(["skill_files:skill_csv", "skill_files:skill flat"]);
    expect(reminders[0]!.text).toContain("resolve against /oma/skills/skill_csv/latest/csv/");
  });

  it("states the outputs directory exactly once in the composed prompt", async () => {
    const reminders = sessionResourceReminders(sessionResourceFacts({ outputs: { path: "/mnt/session/outputs" } }), { outputsGuidedByPlatform: true });
    const prompt = composeSystemPrompt("Agent system.", reminders);
    expect(prompt.split("`/mnt/session/outputs/`").length - 1).toBe(1);
  });
});
