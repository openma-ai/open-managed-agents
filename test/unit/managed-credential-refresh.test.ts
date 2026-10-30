// The Cloudflare MCP proxy surfaces managed credential store failures.
import { describe, expect, it } from "vitest";
import { resolveOutboundCredentialByHost } from "../../apps/main/src/routes/mcp-proxy";
import { managedResolver } from "./helpers/managed-resolver";

describe("managed credential store failures", () => {
  it("are rethrown instead of treated as no credentials", async () => {
    const source = managedResolver({
      listByVaults: async () => { throw new Error("d1 unavailable"); },
    });
    const sessions = { find: async () => ({ archivedAt: null, vaultIds: ["vlt_a"], agent: { mcpServers: [] } }) };
    await expect(resolveOutboundCredentialByHost(
      {} as never,
      { sessions: { get: async () => null } } as never,
      "ws",
      "sess",
      "api.github.com",
      sessions,
      source,
    )).rejects.toThrow("d1 unavailable");
  });
});
