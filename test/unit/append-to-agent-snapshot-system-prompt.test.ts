// Pin the contract of `appendToAgentSnapshotSystemPrompt` — the helper that
// integration providers use to push once-per-session protocol prose onto the
// frozen agent snapshot at sessions.create time. Slack uses it for the
// `<oma_signal>` catalog (see SLACK_SIGNAL_PROTOCOL_PROMPT) so the kilobytes
// of stable text don't have to ride on every webhook-derived user.message.
//
// Companion to inject-mcp-servers-into-snapshot.test.ts; both pin the
// contract of internal.ts's snapshot-augmentation helpers.

import { describe, it, expect } from "vitest";
import { appendToAgentSnapshotSystemPrompt } from "../../apps/main/src/routes/internal";
import type { AgentConfig } from "@open-managed-agents/shared";

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent-test",
    name: "test",
    model: "claude-sonnet-4-6",
    system: "",
    tools: [],
    mcp_servers: [],
    ...overrides,
  } as AgentConfig;
}

describe("appendToAgentSnapshotSystemPrompt", () => {
  it("appends to a non-empty system with a blank-line separator", () => {
    const out = appendToAgentSnapshotSystemPrompt(
      baseAgent({ system: "You are helpful." }),
      "Slack protocol: foo",
    );
    expect(out.system).toBe("You are helpful.\n\nSlack protocol: foo");
  });

  it("does not double-blank-line when system already ends in a newline", () => {
    const out = appendToAgentSnapshotSystemPrompt(
      baseAgent({ system: "You are helpful.\n" }),
      "extra",
    );
    expect(out.system).toBe("You are helpful.\nextra");
  });

  it("appends without separator when system is empty", () => {
    const out = appendToAgentSnapshotSystemPrompt(
      baseAgent({ system: "" }),
      "Slack protocol",
    );
    expect(out.system).toBe("Slack protocol");
  });

  it("is a no-op (returns same reference) on undefined or empty additional", () => {
    const agent = baseAgent({ system: "x" });
    expect(appendToAgentSnapshotSystemPrompt(agent, undefined)).toBe(agent);
    expect(appendToAgentSnapshotSystemPrompt(agent, "")).toBe(agent);
    expect(appendToAgentSnapshotSystemPrompt(agent, "   \n\t  ")).toBe(agent);
  });

  it("doesn't mutate the input snapshot", () => {
    const agent = baseAgent({ system: "original" });
    const out = appendToAgentSnapshotSystemPrompt(agent, "added");
    expect(agent.system).toBe("original");
    expect(out).not.toBe(agent);
    expect(out.system).toBe("original\n\nadded");
  });

  it("preserves all other fields unchanged", () => {
    const agent = baseAgent({
      system: "x",
      tools: [{ type: "agent_toolset_20260401" }],
      mcp_servers: [{ name: "linear", type: "url", url: "https://mcp.linear.app/mcp" }],
    });
    const out = appendToAgentSnapshotSystemPrompt(agent, "y");
    expect(out.tools).toEqual(agent.tools);
    expect(out.mcp_servers).toEqual(agent.mcp_servers);
    expect(out.id).toBe(agent.id);
    expect(out.name).toBe(agent.name);
    expect(out.model).toBe(agent.model);
  });
});
