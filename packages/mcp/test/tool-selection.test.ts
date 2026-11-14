import { describe, expect, it } from "vitest";
import { isMcpToolEnabled } from "../src/tool-selection";

describe("isMcpToolEnabled", () => {
  it.each([
    { tools: [], name: "read", want: true },
    { tools: [{ type: "mcp_toolset", mcp_server_name: "other", default_config: { enabled: false } }], name: "read", want: true },
    { tools: [{ type: "mcp_toolset", mcp_server_name: "server" }], name: "read", want: true },
    { tools: [{ type: "mcp_toolset", mcp_server_name: "server", default_config: { enabled: false } }], name: "read", want: false },
    { tools: [{ type: "mcp_toolset", mcp_server_name: "server", default_config: { enabled: false }, configs: [{ name: "read", enabled: true }] }], name: "read", want: true },
    { tools: [{ type: "mcp_toolset", mcp_server_name: "server", default_config: { enabled: true }, configs: [{ name: "read", enabled: false }] }], name: "read", want: false },
    { tools: [{ type: "mcp_toolset", mcp_server_name: "server", default_config: { enabled: false }, configs: [{ name: "read" }] }], name: "read", want: false },
    { tools: [{ type: "custom", name: "read" }], name: "read", want: true },
  ])("applies tool override, then server default, then true ($want)", ({ tools, name, want }) => {
    expect(isMcpToolEnabled({ tools }, "server", name)).toBe(want);
  });
  it("uses the first matching toolset and the first matching tool config", () => {
    expect(isMcpToolEnabled({ tools: [
      { type: "mcp_toolset", mcp_server_name: "server", configs: [{ name: "read", enabled: false }, { name: "read", enabled: true }] },
      { type: "mcp_toolset", mcp_server_name: "server", default_config: { enabled: true } },
    ] }, "server", "read")).toBe(false);
  });
});
