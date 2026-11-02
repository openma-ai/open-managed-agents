import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@open-managed-agents/shared";
import {
  restoreLoadedToolNames,
  TOOL_ASSEMBLY_WARNING_SOURCE,
} from "../src/harness/assembly/loaded-tools-state";

describe("restoreLoadedToolNames", () => {
  it("restores from session.warning assembly events", () => {
    const events: SessionEvent[] = [
      {
        type: "session.warning",
        source: TOOL_ASSEMBLY_WARNING_SOURCE,
        message: "loaded",
        details: { loadedToolNames: ["mcp__github__search"] },
      },
    ];
    expect([...restoreLoadedToolNames(events)]).toEqual(["mcp__github__search"]);
  });

  it("restores from tool_search tool_use / tool_result pairs", () => {
    const events: SessionEvent[] = [
      {
        type: "agent.tool_use",
        id: "tu-1",
        name: "tool_search",
        input: { query: "issue" },
      },
      {
        type: "agent.tool_result",
        tool_use_id: "tu-1",
        content: "Loaded 1 tool(s) for the next turn:\n\n## mcp__github__create_issue\nOpen issue",
      },
    ];
    expect([...restoreLoadedToolNames(events)]).toEqual(["mcp__github__create_issue"]);
  });

  it("restores from custom_tool_use and ContentBlock[] tool_result (Pi harness)", () => {
    const events: SessionEvent[] = [
      {
        type: "agent.custom_tool_use",
        id: "tu-pi-1",
        name: "tool_search",
        input: { query: "issue" },
      },
      {
        type: "agent.tool_result",
        tool_use_id: "tu-pi-1",
        content: [
          { type: "text", text: "Loaded 1 tool(s) for the next turn:\n\n## mcp__github__create_issue\nOpen issue" },
        ],
      },
    ];
    expect([...restoreLoadedToolNames(events)]).toEqual(["mcp__github__create_issue"]);
  });

  it("unions warning and history", () => {
    const events: SessionEvent[] = [
      {
        type: "session.warning",
        source: TOOL_ASSEMBLY_WARNING_SOURCE,
        message: "loaded",
        details: { loadedToolNames: ["mcp__github__search"] },
      },
      {
        type: "agent.tool_use",
        id: "tu-2",
        name: "tool_search",
        input: { query: "docs" },
      },
      {
        type: "agent.tool_result",
        tool_use_id: "tu-2",
        content: "## mcp__docs__lookup\nLookup",
      },
    ];
    const loaded = restoreLoadedToolNames(events);
    expect(loaded.has("mcp__github__search")).toBe(true);
    expect(loaded.has("mcp__docs__lookup")).toBe(true);
  });
});
