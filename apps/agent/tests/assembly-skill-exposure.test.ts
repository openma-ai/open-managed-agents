import { describe, expect, it } from "vitest";
import { planSkillExposure } from "../src/harness/assembly/strategies/skill-exposure";
import type { SkillMountDescriptor } from "../src/harness/skills";

const model = {
  id: "test",
  provider: "faux",
  api: "faux",
  contextWindow: 10_000,
  maxTokens: 2_000,
} as const;

const mounts: SkillMountDescriptor[] = [
  {
    skillId: "skill_a",
    name: "Skill A",
    description: "Does A things",
    mountRoot: "/workspace/.openma/skills/skill_a/latest/",
    body: "# Skill A\n\nBody A",
    source: "custom",
  },
  {
    skillId: "skill_b",
    name: "Skill B",
    description: "Does B things",
    mountRoot: "/workspace/.openma/skills/skill_b/latest/",
    body: "# Skill B\n\nBody B",
    source: "custom",
  },
];

describe("skill exposure strategies", () => {
  it("progressive lists skills without SKILL.md bodies", () => {
    const plan = planSkillExposure({
      mounts,
      loadedSkillIds: new Set(),
      config: { mode: "progressive", listBudgetFraction: 0.02, maxDescriptionChars: 1024 },
      model,
    });
    expect(plan.systemSection).toContain("<available-skills>");
    expect(plan.systemSection).toContain("skill_a");
    expect(plan.systemSection).not.toContain("Body A");
    expect(plan.inlinedSkillIds).toEqual([]);
  });

  it("inline embeds full SKILL.md bodies", () => {
    const plan = planSkillExposure({
      mounts,
      loadedSkillIds: new Set(),
      config: { mode: "inline", listBudgetFraction: 0.02, maxDescriptionChars: 1024 },
      model,
    });
    expect(plan.systemSection).toContain("<skill name=\"Skill A\">");
    expect(plan.systemSection).toContain("Body A");
    expect(plan.inlinedSkillIds).toEqual(["skill_a", "skill_b"]);
  });

  it("budgeted defers skills that exceed the list budget", () => {
    const heavy = mounts.map((mount) => ({
      ...mount,
      description: "x".repeat(4_000),
    }));
    const plan = planSkillExposure({
      mounts: heavy,
      loadedSkillIds: new Set(),
      config: { mode: "budgeted", listBudgetFraction: 0.01, maxDescriptionChars: 4096 },
      model: { ...model, contextWindow: 2_000 },
    });
    expect(plan.listedSkillIds.length).toBeLessThan(heavy.length);
    expect(plan.deferredSkillIds.length).toBeGreaterThan(0);
    expect(plan.systemSection).toContain("tool_search");
  });

  it("tool mode references the skill tool and inlines loaded bodies", () => {
    const plan = planSkillExposure({
      mounts,
      loadedSkillIds: new Set(["skill_a"]),
      config: { mode: "tool", listBudgetFraction: 0.02, maxDescriptionChars: 1024 },
      model,
    });
    expect(plan.systemSection).toContain("`skill` tool");
    expect(plan.systemSection).toContain("Body A");
  });
});
