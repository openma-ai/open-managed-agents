import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@open-managed-agents/shared";
import { CONTEXT_REASSEMBLED_WARNING_SOURCE } from "../src/harness/assembly/context-reassembled-state";
import { TOOL_ASSEMBLY_WARNING_SOURCE } from "../src/harness/assembly/loaded-tools-state";
import { SKILL_ASSEMBLY_WARNING_SOURCE } from "../src/harness/assembly/loaded-skills-state";
import {
  buildLoadedSkillRetentionSection,
  resolvePostCompactionAssembly,
} from "../src/harness/assembly/post-compaction-reassembly";
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
    description: "A",
    mountRoot: "/m/a/",
    body: "# A\n\n" + "x".repeat(100),
    source: "custom",
  },
  {
    skillId: "skill_b",
    name: "Skill B",
    description: "B",
    mountRoot: "/m/b/",
    body: "# B\n\nbody",
    source: "custom",
  },
];

describe("post-compaction re-assembly", () => {
  it("broadcasts oma.context_reassembled after compaction and inlines loaded skills", () => {
    const events: SessionEvent[] = [
      {
        type: "session.warning",
        source: SKILL_ASSEMBLY_WARNING_SOURCE,
        message: "loaded",
        details: { loadedSkillIds: ["skill_a", "skill_b"] },
      },
      {
        type: "session.warning",
        source: TOOL_ASSEMBLY_WARNING_SOURCE,
        message: "tools",
        details: { loadedToolNames: ["mcp__gh__one", "mcp__gh__two"] },
      },
      {
        type: "agent.thread_context_compacted",
        summary: [{ type: "text", text: "summary" }],
        original_message_count: 10,
        compacted_message_count: 2,
      },
    ];
    const broadcasted: SessionEvent[] = [];
    const loadedTools = new Set(["mcp__gh__one", "mcp__gh__two"]);

    const result = resolvePostCompactionAssembly({
      events,
      mounts,
      loadedTools,
      config: {
        perSkillTokenBudget: 5_000,
        totalSkillTokenBudget: 25_000,
        toolRetention: "recent",
        recentToolLimit: 1,
        contextWindowPolicy: "summary",
      },
      model,
      broadcast: (event) => broadcasted.push(event),
    });

    expect(result.applied).toBe(true);
    expect(result.skillRetentionSection).toContain("<post-compaction-loaded-skills>");
    expect(result.skillRetentionSection).toContain("Skill B");
    expect(result.retainedToolNames).toEqual(["mcp__gh__two"]);
    expect(broadcasted).toContainEqual(expect.objectContaining({
      type: "session.warning",
      source: CONTEXT_REASSEMBLED_WARNING_SOURCE,
    }));
  });

  it("rebuilds retention section on later turns without re-broadcasting", () => {
    const events: SessionEvent[] = [
      {
        type: "session.warning",
        source: SKILL_ASSEMBLY_WARNING_SOURCE,
        message: "loaded",
        details: { loadedSkillIds: ["skill_b"] },
      },
      {
        type: "agent.thread_context_compacted",
        summary: [{ type: "text", text: "summary" }],
        original_message_count: 4,
        compacted_message_count: 1,
      },
      {
        type: "session.warning",
        source: CONTEXT_REASSEMBLED_WARNING_SOURCE,
        message: "re-assembled",
        details: {
          afterCompactionIndex: 1,
          loadedToolNames: [],
          loadedSkillIds: ["skill_b"],
          inlinedSkillIds: ["skill_b"],
        },
      },
    ];
    const broadcast = vi.fn();
    const loadedTools = new Set<string>();
    const result = resolvePostCompactionAssembly({
      events,
      mounts,
      loadedTools,
      config: {
        perSkillTokenBudget: 5_000,
        totalSkillTokenBudget: 25_000,
        toolRetention: "recent",
        recentToolLimit: 8,
        contextWindowPolicy: "summary",
      },
      model,
      broadcast,
    });
    expect(result.applied).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
    expect(result.skillRetentionSection).toContain("body");
  });

  it("respects total skill token budget", () => {
    const heavy: SkillMountDescriptor[] = [{
      skillId: "heavy",
      name: "Heavy",
      description: "h",
      mountRoot: "/m/h/",
      body: "z".repeat(20_000),
      source: "custom",
    }];
    const { section, inlinedSkillIds } = buildLoadedSkillRetentionSection({
      mounts: heavy,
      loadedSkillIdsOrdered: ["heavy"],
      config: {
        perSkillTokenBudget: 25_000,
        totalSkillTokenBudget: 100,
        toolRetention: "all",
        recentToolLimit: 8,
        contextWindowPolicy: "summary",
      },
      model,
    });
    expect(inlinedSkillIds).toEqual([]);
    expect(section).toBe("");
  });

  it("clears loaded tools when retention is clear", () => {
    const events: SessionEvent[] = [
      {
        type: "session.warning",
        source: TOOL_ASSEMBLY_WARNING_SOURCE,
        message: "loaded",
        details: { loadedToolNames: ["mcp__x__a"] },
      },
      {
        type: "agent.thread_context_compacted",
        summary: [{ type: "text", text: "summary" }],
        original_message_count: 2,
        compacted_message_count: 1,
      },
    ];
    const loadedTools = new Set(["mcp__x__a"]);
    resolvePostCompactionAssembly({
      events,
      mounts: [],
      loadedTools,
      config: {
        perSkillTokenBudget: 5_000,
        totalSkillTokenBudget: 25_000,
        toolRetention: "clear",
        recentToolLimit: 8,
        contextWindowPolicy: "summary",
      },
      model,
      broadcast: () => {},
    });
    expect(loadedTools.size).toBe(0);
  });
});
