import { describe, expect, it } from "vitest";
import type { RuntimeAgentConfig as AgentConfig } from "@open-managed-agents/api-types";

import { answerAcpPermission } from "../../apps/agent/src/harness/acp-permission";

const options = [
  { optionId: "allow", kind: "allow_once" },
  { optionId: "always", kind: "allow_always" },
  { optionId: "reject", kind: "reject_once" },
];
const call = (toolName?: string) => ({
  toolCall: toolName === undefined ? {} : { _meta: { claudeCode: { toolName } } },
  options,
});
const agent = (tools: unknown[]) => ({ tools } as unknown as AgentConfig);

describe("answerAcpPermission", () => {
  it("allows Claude Code's Bash under the default agent toolset", () => {
    expect(answerAcpPermission(agent([{ type: "agent_toolset_20260401" }]), call("Bash")))
      .toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("maps Claude Code tool names onto the agent toolset policy", () => {
    const config = agent([{
      type: "agent_toolset_20260401",
      configs: [{ name: "bash", permission_policy: { type: "always_ask" } }],
    }]);
    expect(answerAcpPermission(config, call("Bash")))
      .toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
    expect(answerAcpPermission(config, call("Read")))
      .toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("applies the MCP toolset policy to mcp__server__tool names", () => {
    const config = agent([{
      type: "mcp_toolset",
      mcp_server_name: "maxcompute",
      default_config: { permission_policy: { type: "always_ask" } },
      configs: [{ name: "query", permission_policy: { type: "always_allow" } }],
    }]);
    expect(answerAcpPermission(config, call("mcp__maxcompute__query")))
      .toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(answerAcpPermission(config, call("mcp__maxcompute__drop")))
      .toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("falls back to the toolset default when the tool name is unknown", () => {
    const config = agent([{
      type: "agent_toolset_20260401",
      default_config: { permission_policy: { type: "always_ask" } },
    }]);
    expect(answerAcpPermission(config, call())).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });

  it("uses allow_always when no allow_once option is offered, and cancels without a matching option", () => {
    const config = agent([]);
    expect(answerAcpPermission(config, { ...call("Bash"), options: [{ optionId: "always", kind: "allow_always" }] }))
      .toEqual({ outcome: { outcome: "selected", optionId: "always" } });
    expect(answerAcpPermission(config, { ...call("Bash"), options: [] }))
      .toEqual({ outcome: { outcome: "cancelled" } });
  });
});
