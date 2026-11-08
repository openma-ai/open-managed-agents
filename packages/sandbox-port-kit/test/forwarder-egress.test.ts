import { describe, expect, it } from "vitest";
import type { EgressPolicy } from "@open-managed-agents/sandbox";
import { createForwarderEgress } from "../src/forwarder-egress";
import type { FirewallRules } from "../src/firewall";
import type { SandboxEgressDepsPort, SandboxVendorPort } from "../src/ports";

// Characterization (#545 sandbox core move): the rules createForwarderEgress
// hands a vendor firewall today. Platform channels are empty, so a limited
// Environment with a github_repository resource does not reach the
// repository host (design §0.6, 2026-11-08, changes this deliberately).

const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "work" };
const fence = { ...scope, ownerId: "owner", generation: 1, token: "t", expiresAt: "2030-01-01T00:00:00.000Z" };
const signal = new AbortController().signal;

function vendor(applied: FirewallRules[]): SandboxVendorPort<object> {
  return {
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async readFile() { return null; },
    async writeFile() {},
    async setEnv() {},
    async applyFirewall(_runtime, rules) { applied.push(rules); },
  };
}

const deps: SandboxEgressDepsPort = {
  gateway: {
    endpoint: { url: "https://gw.example.com" },
    issueToken: async () => "token",
    authenticate: async () => null,
    handle: async () => new Response(null, { status: 403 }),
  },
};

const limited: EgressPolicy = {
  scope: { workspaceId: "ws", sessionId: "sess", generation: 1 },
  networking: { type: "limited", hosts: ["api.example.com"], packageSources: [], mcpHosts: [] },
  substitutions: [],
};

describe("createForwarderEgress firewall today (characterization)", () => {
  it("applies the limited allowlist with no platform channels", async () => {
    const applied: FirewallRules[] = [];
    await createForwarderEgress(vendor(applied), deps).attach({ runtime: {}, scope, fence, policy: limited, signal });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ mode: "allowlist", allowHosts: ["api.example.com"], includesGateway: false });
    expect(applied[0]!.allowHosts).not.toContain("github.com");
  });
});
