import { describe, expect, it } from "vitest";
import {
  sessionMemoryResourceFact,
  sessionResourceFacts,
  sessionResourceReminders,
  sessionSkillResourceFact,
} from "@open-managed-agents/runtime-resource-contract";
import { sessionTurnResourceGuidance } from "../src/session-resource-guidance";

// One turn-guidance derivation for the Cloudflare SessionDO and the Node runner.
describe("sessionTurnResourceGuidance", () => {
  const skill = sessionSkillResourceFact({ skillId: "skill_1", name: "Report", manifestPath: "/oma/skills/skill_1/1/report/SKILL.md" });
  const memory = sessionMemoryResourceFact({ storeId: "memstore_1", storeName: "notes", access: "read_only" });

  it("uses the sandbox's resolved workspace root and the shared reminder options", async () => {
    const guidance = await sessionTurnResourceGuidance({
      sandbox: { resolveWorkspaceRoot: async () => "/home/user/project" },
      skills: [skill],
      memoryStores: [memory],
    });
    const expectedFacts = sessionResourceFacts({
      workspaceRoot: "/home/user/project", skills: [skill], memoryStores: [memory], outputs: { path: "/mnt/session/outputs" },
    });
    expect(guidance.facts).toEqual(expectedFacts);
    expect(guidance.reminders).toEqual(sessionResourceReminders(expectedFacts, { outputsGuidedByPlatform: true, includeWorkspace: true }));
    expect(guidance.reminders.map(reminder => reminder.source)).toContain("session_workspace");
    // Outputs at the standard path are already stated by the platform guidance.
    expect(guidance.reminders.map(reminder => reminder.source)).not.toContain("session_outputs");
  });

  it("falls back to the protocol workspace when the sandbox does not resolve one", async () => {
    const guidance = await sessionTurnResourceGuidance({ sandbox: {}, skills: [], memoryStores: [] });
    expect(guidance.facts.workspaceRoot).toBe("/workspace");
    expect(guidance.facts.outputs).toEqual({ path: "/mnt/session/outputs" });
    expect(guidance.reminders.map(reminder => reminder.source)).toEqual(["session_workspace"]);
  });
});
