import { describe, expect, it } from "vitest";
import {
  SESSION_MEMORY_ROOT,
  SESSION_OUTPUTS_PATH,
  SESSION_SKILLS_ROOT,
  SESSION_WORKSPACE_ROOT,
  sessionMemoryResourceFact,
  sessionMemoryStorePath,
  sessionResourceEnvironment,
  sessionResourceFacts,
  sessionResourceReminders,
  sessionSkillResourceFact,
  sessionSkillVersionRoot,
} from "@open-managed-agents/runtime-resource-contract";

describe("Session resource facts contract", () => {
  it("derives Memory mount paths from the mounted store name and rejects names a mount cannot create", () => {
    expect(sessionMemoryStorePath("notes")).toBe("/mnt/memory/notes");
    expect(sessionMemoryStorePath("Project Knowledge")).toBe("/mnt/memory/Project Knowledge");
    for (const bad of ["", ".", "..", "a/b", "a\\b", "x\0y"]) {
      expect(() => sessionMemoryStorePath(bad)).toThrow("cannot be mounted");
    }
  });

  it("defaults an unknown access to read_write and keeps read_only explicit", () => {
    expect(sessionMemoryResourceFact({ storeId: "ms_1", storeName: "a" }).access).toBe("read_write");
    expect(sessionMemoryResourceFact({ storeId: "ms_1", storeName: "a", access: null }).access).toBe("read_write");
    expect(sessionMemoryResourceFact({ storeId: "ms_1", storeName: "a", access: "read_only" }).access).toBe("read_only");
  });

  it("derives a Skill directory from the SKILL.md the runtime wrote", () => {
    const root = sessionSkillVersionRoot("skill_a b", "latest");
    expect(root).toBe(`${SESSION_SKILLS_ROOT}/skill_a%20b/latest`);
    const fact = sessionSkillResourceFact({ skillId: "skill_a", name: "csv", manifestPath: `${root}/csv/SKILL.md` });
    expect(fact.directory).toBe(`${root}/csv`);
    // In-sandbox materializers pass the root they actually wrote to.
    expect(sessionSkillVersionRoot("s", "3", "/workspace/.openma/skills/")).toBe("/workspace/.openma/skills/s/3");
    expect(() => sessionSkillResourceFact({ skillId: "s", manifestPath: "relative/SKILL.md" })).toThrow("absolute");
    expect(() => sessionSkillResourceFact({ skillId: "s", manifestPath: "/oma/skills/s/1/README.md" })).toThrow("SKILL.md");
    expect(() => sessionSkillResourceFact({ skillId: "s", manifestPath: "/oma/skills/../SKILL.md" })).toThrow("'..'");
    expect(() => sessionSkillVersionRoot("s", "1", "oma/skills")).toThrow("absolute");
  });

  it("refuses facts that contradict where a store mounts or that collide", () => {
    const store = sessionMemoryResourceFact({ storeId: "ms_1", storeName: "notes" });
    expect(() => sessionResourceFacts({ memoryStores: [{ ...store, path: "/elsewhere/notes" }] })).toThrow("is not where");
    expect(() => sessionResourceFacts({
      memoryStores: [store, sessionMemoryResourceFact({ storeId: "ms_2", storeName: "notes" })],
    })).toThrow("Two Memory Stores");
    expect(() => sessionResourceFacts({ workspaceRoot: "work" })).toThrow("absolute");
  });

  it("derives env only for resources that are present", () => {
    expect(sessionResourceEnvironment(sessionResourceFacts({}))).toEqual({});
    const facts = sessionResourceFacts({
      memoryStores: [
        sessionMemoryResourceFact({ storeId: "ms_1", storeName: "team-notes" }),
        sessionMemoryResourceFact({ storeId: "ms_2", storeName: "Ref Docs", access: "read_only" }),
      ],
      outputs: { path: `${SESSION_OUTPUTS_PATH}/` },
    });
    expect(sessionResourceEnvironment(facts)).toEqual({
      OMA_MEMORY_DIR: SESSION_MEMORY_ROOT,
      OMA_MEMORY_TEAM_NOTES: "/mnt/memory/team-notes",
      OMA_MEMORY_REF_DOCS: "/mnt/memory/Ref Docs",
      OMA_OUTPUTS_DIR: "/mnt/session/outputs",
    });
    expect(facts.workspaceRoot).toBe(SESSION_WORKSPACE_ROOT);
  });

  it("renders Memory guidance byte-identical to the historical CF block", () => {
    const facts = sessionResourceFacts({
      memoryStores: [
        sessionMemoryResourceFact({ storeId: "ms_rw", storeName: "notes", description: "Team notes", instructions: "Check first." }),
        sessionMemoryResourceFact({ storeId: "ms_ro", storeName: "ref", access: "read_only" }),
      ],
    });
    expect(sessionResourceReminders(facts)).toEqual([
      { source: "memory:ms_rw", text: "## Memory store: notes\nMounted at /mnt/memory/notes/ (read-write)\nTeam notes\nCheck first." },
      {
        source: "memory:ms_ro",
        text: "## Memory store: ref\nMounted at /mnt/memory/ref/ (read-only)\n(read-only mount — write attempts to this directory will fail)",
      },
    ]);
  });

  it("tells the model where a Skill's relative paths resolve", () => {
    const facts = sessionResourceFacts({
      skills: [sessionSkillResourceFact({ skillId: "sk_1", name: "csv", manifestPath: "/oma/skills/sk_1/2/csv/SKILL.md" })],
    });
    const [reminder] = sessionResourceReminders(facts);
    expect(reminder!.source).toBe("skill_files:sk_1");
    expect(reminder!.text).toContain("installed at /oma/skills/sk_1/2/csv/");
    expect(reminder!.text).toContain("resolve against /oma/skills/sk_1/2/csv/");
    expect(reminder!.text).toContain("cd '/oma/skills/sk_1/2/csv'");
  });

  it("emits outputs guidance unless the platform prompt already covers the same path", () => {
    const facts = sessionResourceFacts({ outputs: { path: SESSION_OUTPUTS_PATH } });
    expect(sessionResourceReminders(facts).map(r => r.source)).toEqual(["session_outputs"]);
    expect(sessionResourceReminders(facts)[0]!.text).toContain("`/mnt/session/outputs/`");
    expect(sessionResourceReminders(facts, { outputsGuidedByPlatform: true })).toEqual([]);
    // A different collected path is never hidden behind the static platform text.
    const moved = sessionResourceFacts({ outputs: { path: "/workspace/out" } });
    expect(sessionResourceReminders(moved, { outputsGuidedByPlatform: true })[0]!.text).toContain("`/workspace/out/`");
    // No outputs fact, no outputs guidance (env-only or absent outputs never become prompt claims).
    expect(sessionResourceReminders(sessionResourceFacts({}))).toEqual([]);
  });

  it("orders reminders skills, memory, outputs and is byte-stable for equal facts", () => {
    const build = () => sessionResourceFacts({
      skills: [sessionSkillResourceFact({ skillId: "sk", name: "", manifestPath: "/oma/skills/sk/1/SKILL.md" })],
      memoryStores: [sessionMemoryResourceFact({ storeId: "ms", storeName: "m" })],
      outputs: { path: SESSION_OUTPUTS_PATH },
    });
    const a = sessionResourceReminders(build());
    expect(a.map(r => r.source)).toEqual(["skill_files:sk", "memory:ms", "session_outputs"]);
    expect(a[0]!.text).toContain('Skill "sk"');
    expect(JSON.stringify(sessionResourceReminders(build()))).toBe(JSON.stringify(a));
  });
});
