import { describe, expect, it } from "vitest";
import { resolveToolAssemblyConfig } from "../src/harness/assembly/config";
import {
  formatClaudeCodeDeferredReminder,
} from "../src/harness/assembly/deferred-prompt";
import { createDeferredHintCoordinator } from "../src/harness/assembly/strategies/deferred-hints";

const DEFERRED = ["mcp__github__create_issue", "mcp__docs__lookup"];

describe("resolveToolAssemblyConfig deferred hints", () => {
  it("leaves the strategy unset so the assembly picks it by invocation mode", () => {
    const config = resolveToolAssemblyConfig({ id: "a", model: "m", system: "s" });
    expect(config.deferredHintStrategy).toBeUndefined();
  });

  it("reads tool_search_deferred_hints from metadata", () => {
    const config = resolveToolAssemblyConfig({
      id: "a",
      model: "m",
      system: "s",
      metadata: { tool_search_deferred_hints: "incremental" },
    });
    expect(config.deferredHintStrategy).toBe("incremental");
  });
});

describe("deferred hint strategies", () => {
  const plan = { toolSearchEnabled: true, deferredNames: DEFERRED };

  it("claude_code: bootstrap lists deferred tools; turn refresh on every boundary", () => {
    const hints = createDeferredHintCoordinator("claude_code");
    expect(hints.augmentSystemPrompt("base", plan)).toBe("base");
    const bootstrap = hints.bootstrapTurnMessages(plan);
    expect(bootstrap).toHaveLength(1);
    expect(bootstrap[0]?.content).toContain("tool_search");
    expect(bootstrap[0]?.content).toContain("mcp__github__create_issue");

    const firstTurn = hints.prepareNextTurn(plan, "");
    expect(firstTurn.messages).toHaveLength(1);
    expect(firstTurn.messages?.[0]?.content).toContain("mcp__docs__lookup");

    const sameSet = hints.prepareNextTurn(plan, firstTurn.nextDeferredHintKey);
    expect(sameSet.messages).toHaveLength(1);
  });

  it("incremental: system index; suppress first next-turn hint; remind on set change", () => {
    const hints = createDeferredHintCoordinator("incremental");
    expect(hints.augmentSystemPrompt("base", plan)).toContain("<deferred-tools>");
    expect(hints.bootstrapTurnMessages(plan)).toHaveLength(0);

    const initialKey = hints.initialDeferredHintKey(plan);
    expect(hints.prepareNextTurn(plan, initialKey).messages).toBeUndefined();

    const shrunk = { ...plan, deferredNames: ["mcp__github__create_issue"] };
    const changed = hints.prepareNextTurn(shrunk, initialKey);
    expect(changed.messages?.[0]?.content).toContain("Deferred tools changed");
    expect(changed.messages?.[0]?.content).toContain("1 still unloaded");
  });

  it("pi: deferred block in system only", () => {
    const hints = createDeferredHintCoordinator("pi");
    expect(hints.augmentSystemPrompt("base", plan)).toContain("## github");
    expect(hints.bootstrapTurnMessages(plan)).toHaveLength(0);
    expect(hints.prepareNextTurn(plan, "").messages).toBeUndefined();
  });

  it("codex: no extra hints", () => {
    const hints = createDeferredHintCoordinator("codex");
    expect(hints.augmentSystemPrompt("base", plan)).toBe("base");
    expect(hints.bootstrapTurnMessages(plan)).toHaveLength(0);
    expect(hints.prepareNextTurn(plan, "").messages).toBeUndefined();
  });
});

describe("formatClaudeCodeDeferredReminder", () => {
  it("mentions select syntax and tool names", () => {
    const text = formatClaudeCodeDeferredReminder(["mcp__github__createIssue"]);
    expect(text).toContain("select:<name>");
    expect(text).toContain("mcp__github__createIssue");
  });
});
