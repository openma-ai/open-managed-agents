// Regression tests for the bug surfaced on 2026-05-19:
//
// Slack-published agent gets dispatched on @mention, session has the slack
// vault + server attached, but the model literally tells users to run curl
// commands because no `mcp__slack__*` tool is wired in. Root cause: the
// publish dispatch path was adding the server to `agent_snapshot.mcp_servers`
// but NOT to `agent_snapshot.tools[]` as an `mcp_toolset` declaration —
// and the agent harness only exposes tools when both are present.
//
// `injectMcpServersIntoSnapshot` is the single source of truth for that
// augmentation; pin its behavior so a future "let's just refactor the
// publish path" doesn't silently revert this.

import { describe, it, expect } from "vitest";
import {
  injectMcpServersIntoSnapshot,
  mergePublishedMcpIntoSessionSnapshot,
} from "../../apps/main/src/routes/internal";
import type { AgentConfig } from "@open-managed-agents/shared";

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent-test",
    name: "test",
    model: "claude-sonnet-4-6",
    system: "",
    tools: [{ type: "agent_toolset_20260401" }],
    mcp_servers: [],
    ...overrides,
  } as AgentConfig;
}

describe("injectMcpServersIntoSnapshot", () => {
  it("adds both the server entry AND the mcp_toolset declaration", () => {
    const out = injectMcpServersIntoSnapshot(baseAgent(), [
      { name: "slack", url: "https://mcp.slack.com/mcp" },
    ]);
    expect(out.mcp_servers).toEqual([
      { name: "slack", type: "url", url: "https://mcp.slack.com/mcp" },
    ]);
    // The toolset entry is what makes the model actually see slack tools.
    const slackToolset = (out.tools as Array<{ type: string; mcp_server_name?: string }>).find(
      (t) => t.type === "mcp_toolset" && t.mcp_server_name === "slack",
    );
    expect(slackToolset).toBeTruthy();
  });

  it("injects always_allow permission for the auto-added toolset", () => {
    const out = injectMcpServersIntoSnapshot(baseAgent(), [
      { name: "slack", url: "https://mcp.slack.com/mcp" },
    ]);
    const slack = (out.tools as Array<{ type: string; default_config?: { permission_policy?: { type?: string } } }>)
      .find((t) => t.type === "mcp_toolset");
    expect(slack?.default_config?.permission_policy?.type).toBe("always_allow");
  });

  it("does not double-add a toolset for a server the agent already declares", () => {
    const agent = baseAgent({
      tools: [
        { type: "agent_toolset_20260401" },
        // Existing mcp_toolset for slack with always_ask (user-configured).
        {
          type: "mcp_toolset",
          mcp_server_name: "slack",
          default_config: { permission_policy: { type: "always_ask" } },
          // @ts-expect-error — see internal.ts; mcp_toolset has an extension field
        },
      ],
    });
    const out = injectMcpServersIntoSnapshot(agent, [
      { name: "slack", url: "https://mcp.slack.com/mcp" },
    ]);
    const slackTools = (out.tools as Array<{ type: string; mcp_server_name?: string; default_config?: { permission_policy?: { type?: string } } }>)
      .filter((t) => t.type === "mcp_toolset" && t.mcp_server_name === "slack");
    // Exactly one — the pre-existing always_ask one, NOT a freshly injected always_allow duplicate.
    expect(slackTools).toHaveLength(1);
    expect(slackTools[0].default_config?.permission_policy?.type).toBe("always_ask");
  });

  it("handles multiple servers at once, preserving order", () => {
    const out = injectMcpServersIntoSnapshot(baseAgent(), [
      { name: "slack", url: "https://mcp.slack.com/mcp" },
      { name: "linear", url: "https://mcp.linear.app/mcp" },
    ]);
    expect(out.mcp_servers?.map((s) => s.name)).toEqual(["slack", "linear"]);
    const injectedNames = (out.tools as Array<{ type: string; mcp_server_name?: string }>)
      .filter((t) => t.type === "mcp_toolset")
      .map((t) => t.mcp_server_name);
    expect(injectedNames).toEqual(["slack", "linear"]);
  });

  it("preserves existing mcp_servers and tools", () => {
    const agent = baseAgent({
      tools: [
        { type: "agent_toolset_20260401" },
        // @ts-expect-error — mcp_toolset extension field
        { type: "mcp_toolset", mcp_server_name: "airtable", default_config: { permission_policy: { type: "always_allow" } } },
      ],
      mcp_servers: [{ name: "airtable", type: "url", url: "https://mcp.airtable.com/mcp" }],
    });
    const out = injectMcpServersIntoSnapshot(agent, [
      { name: "slack", url: "https://mcp.slack.com/mcp" },
    ]);
    expect(out.mcp_servers?.map((s) => s.name)).toEqual(["airtable", "slack"]);
    // The original agent_toolset_20260401 + the original airtable mcp_toolset
    // + the new slack one = 3 entries.
    expect(out.tools).toHaveLength(3);
  });

  it("no-ops on an empty server list (preserves identity-of-shape)", () => {
    const agent = baseAgent();
    const out = injectMcpServersIntoSnapshot(agent, []);
    expect(out).toBe(agent);
  });

  it("respects the caller's `type` override (e.g. sse) when provided", () => {
    const out = injectMcpServersIntoSnapshot(baseAgent(), [
      { name: "slack", url: "https://mcp.slack.com/sse", type: "sse" },
    ]);
    expect(out.mcp_servers?.[0]).toEqual({
      name: "slack",
      type: "sse",
      url: "https://mcp.slack.com/sse",
    });
  });

  it("defaults `type` to 'url' when caller omits it", () => {
    const out = injectMcpServersIntoSnapshot(baseAgent(), [
      { name: "slack", url: "https://mcp.slack.com/mcp" },
    ]);
    expect(out.mcp_servers?.[0]?.type).toBe("url");
  });
});

describe("mergePublishedMcpIntoSessionSnapshot", () => {
  it("refreshes MCP settings when an active session resumes without replacing frozen session configuration", () => {
    const staleSnapshot = baseAgent({
      system: "Frozen integration protocol prompt",
      metadata: { session_marker: "keep-me" },
      tools: [
        { type: "agent_toolset_20260401", configs: [{ name: "bash", enabled: false }] },
        // @ts-expect-error — mcp_toolset has an extension field.
        { type: "mcp_toolset", mcp_server_name: "old-server", default_config: { permission_policy: { type: "always_ask" } } },
      ],
      mcp_servers: [{ name: "old-server", type: "url", url: "https://old.example/mcp" }],
    });
    const publishedAgent = baseAgent({
      system: "A later agent edit must not replace the frozen prompt",
      tools: [
        // @ts-expect-error — mcp_toolset has an extension field.
        { type: "mcp_toolset", mcp_server_name: "notion", default_config: { permission_policy: { type: "always_allow" } } },
      ],
      mcp_servers: [{ name: "notion", type: "url", url: "https://notion.example/mcp" }],
    });

    const resumed = mergePublishedMcpIntoSessionSnapshot(
      staleSnapshot,
      publishedAgent,
      [{ name: "slack", url: "https://mcp.slack.com/mcp" }],
    );

    // Published MCP configuration and the current integration endpoint win.
    expect(resumed.mcp_servers).toEqual([
      { name: "notion", type: "url", url: "https://notion.example/mcp" },
      { name: "slack", type: "url", url: "https://mcp.slack.com/mcp" },
    ]);
    expect(resumed.tools).toEqual([
      { type: "agent_toolset_20260401", configs: [{ name: "bash", enabled: false }] },
      { type: "mcp_toolset", mcp_server_name: "notion", default_config: { permission_policy: { type: "always_allow" } } },
      {
        type: "mcp_toolset",
        mcp_server_name: "slack",
        default_config: { permission_policy: { type: "always_allow" } },
      },
    ]);

    // These represent session-specific configuration; the merge deliberately
    // does not replace them while a conversation is active.
    expect(resumed.system).toBe("Frozen integration protocol prompt");
    expect(resumed.metadata).toEqual({ session_marker: "keep-me" });
  });
});
