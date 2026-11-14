// Characterization of the harness surface the Node control plane consumes
// (design §0.7 "harness、history 的位置"). Pins behavior before the harness and
// history leave apps/agent; the same assertions must hold at the new home.
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { RuntimeAgentConfig as AgentConfig } from "@open-managed-agents/api-types";
import {
  registerCoreHarnesses, getHarnessCatalog, resolveHarness, PiHarness,
  composeSystemPrompt, platformGuidance, readHarnessAgentModelSettings,
  agentUsesAssemblySkillMount, eventsToMessages, eventsToMessagesAsync,
  INTERRUPTED_TOOL_RESULT_TEXT, interruptRequiresActionClosure, resolveAppendablePrompts,
  assertRuntimeAgentSnapshot,
} from "@open-managed-agents/agent-harness";

describe("harness registry as the Node host sees it", () => {
  it("registers pi and acp-sandbox with pi as the default", () => {
    registerCoreHarnesses();
    registerCoreHarnesses();
    const catalog = getHarnessCatalog();
    expect(catalog.default_harness_id).toBe("pi");
    expect(catalog.data.map(({ id, execution }) => [id, execution.placement])).toEqual(
      expect.arrayContaining([["pi", "host"], ["acp-sandbox", "sandbox"]]),
    );
    expect(catalog.data.find(({ id }) => id === "acp-sandbox")?.requirements)
      .toEqual(["acp.agent.command|acp.agent.registry"]);
    expect(resolveHarness()).toBeInstanceOf(PiHarness);
    expect(() => resolveHarness("ai-sdk")).toThrow(/Unknown harness/);
    expect(() => resolveHarness("missing")).toThrow(/Unknown harness/);
  });
});

describe("system prompt composition", () => {
  it("appends platform guidance and wraps reminders in source blocks", () => {
    expect(composeSystemPrompt(null)).toBe(platformGuidance);
    expect(composeSystemPrompt("Be brief.")).toBe(`Be brief.\n\n${platformGuidance}`);
    expect(composeSystemPrompt("Be brief.", [{ source: "skill:x", text: "Do X." }]))
      .toBe(`Be brief.\n\n${platformGuidance}\n\n<source name="skill:x">\nDo X.\n</source>`);
  });

  it("resolves appendable prompts by id, once each, skipping unknown ids", () => {
    expect(resolveAppendablePrompts(["linear-mcp", "linear-mcp", "unknown"]).map(({ id }) => id))
      .toEqual(["linear-mcp"]);
  });
});

describe("agent settings read by the Node host", () => {
  it("reads max tokens from either spelling", () => {
    expect(readHarnessAgentModelSettings({ id: "m", max_tokens: 10 })).toEqual({ maxTokens: 10 });
    expect(readHarnessAgentModelSettings({ id: "m", maxTokens: 20 })).toEqual({ maxTokens: 20 });
    expect(readHarnessAgentModelSettings("m")).toBeUndefined();
  });

  it("uses assembly skill mounting for the default and pi harnesses only", () => {
    expect(agentUsesAssemblySkillMount({} as AgentConfig)).toBe(true);
    expect(agentUsesAssemblySkillMount({ harness: "pi" } as AgentConfig)).toBe(true);
    expect(agentUsesAssemblySkillMount({ harness: "acp-sandbox" } as AgentConfig)).toBe(false);
  });

  it("rejects incomplete runtime agent snapshots", () => {
    const agent = { id: "a", name: "A", model: "m", system: "", tools: [], version: 1 };
    expect(() => assertRuntimeAgentSnapshot(agent)).not.toThrow();
    expect(() => assertRuntimeAgentSnapshot({ ...agent, version: 0 })).toThrow(/Incomplete runtime agent snapshot/);
    expect(() => assertRuntimeAgentSnapshot(agent, true)).toThrow(/Incomplete runtime agent snapshot/);
  });
});

describe("history projection", () => {
  const events = [
    { type: "user.message", id: "e1", content: [{ type: "text", text: "hi" }] },
    { type: "agent.tool_use", id: "t1", name: "bash", input: { command: "ls" } },
    { type: "user.interrupt", id: "e2" },
    { type: "user.message", id: "e3", content: [{ type: "text", text: "next" }] },
  ] as unknown as SessionEvent[];
  const expected = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } }] },
    {
      role: "tool",
      content: [{
        type: "tool-result", toolCallId: "t1", toolName: "bash",
        output: { type: "error-json", value: [{ type: "text", text: INTERRUPTED_TOOL_RESULT_TEXT }] },
      }],
    },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ];

  it("closes a tool call cut off by an interrupt before the next user turn", async () => {
    expect(eventsToMessages(events)).toEqual(expected);
    expect(await eventsToMessagesAsync(events, async () => null)).toEqual(expected);
  });

  it("treats an interrupt against a parked thread as a wire no-op", () => {
    expect(interruptRequiresActionClosure(events)).toEqual([]);
  });
});
