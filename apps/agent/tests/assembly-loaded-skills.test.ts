import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@open-managed-agents/shared";
import {
  broadcastLoadedSkillIds,
  restoreLoadedSkillIds,
  SKILL_ASSEMBLY_WARNING_SOURCE,
} from "../src/harness/assembly/loaded-skills-state";

describe("loaded skills state", () => {
  it("restores skill ids from oma.skill_assembly session.warning events", () => {
    const events: SessionEvent[] = [
      {
        type: "session.warning",
        source: SKILL_ASSEMBLY_WARNING_SOURCE,
        message: "loaded",
        details: { loadedSkillIds: ["skill_a", "skill_b"] },
      },
    ];
    expect(restoreLoadedSkillIds(events)).toEqual(new Set(["skill_a", "skill_b"]));
  });

  it("broadcasts loaded skill ids for crash recovery", () => {
    const events: SessionEvent[] = [];
    broadcastLoadedSkillIds((event) => events.push(event), ["skill_x"]);
    expect(events).toEqual([{
      type: "session.warning",
      source: SKILL_ASSEMBLY_WARNING_SOURCE,
      message: "Skill assembly loaded 1 skill(s)",
      details: { loadedSkillIds: ["skill_x"] },
    }]);
  });
});
