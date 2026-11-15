import { describe, expect, it } from "vitest";
import type { EgressPolicy } from "@open-managed-agents/sandbox";
import { allowsHost, compileFirewall, matchesHostPattern, normalizeHostPattern, PLATFORM_DENY_ALWAYS } from "../src/firewall";

const platform = { gateway: { hosts: ["gw.example.com"], fixedIps: ["203.0.113.7"] }, channels: ["files.example.com"] };
const scope = { workspaceId: "ws", sessionId: "sess", generation: 1 };

function limited(substitutions: EgressPolicy["substitutions"] = []): EgressPolicy {
  return {
    scope,
    networking: { type: "limited", hosts: ["API.GitHub.com.", "*.npmjs.org"], packageSources: ["pypi.org"], mcpHosts: ["mcp.example.com"] },
    substitutions,
  };
}

describe("compileFirewall", () => {
  it("opens a null policy and keeps the gateway for runtime vault_ids", () => {
    const rules = compileFirewall(null, platform);
    expect(rules.mode).toBe("open");
    expect(rules.includesGateway).toBe(true);
    expect(rules.allowHosts).toContain("gw.example.com");
    expect(rules.allowCidrs).toEqual(["203.0.113.7/32"]);
    expect(rules.denyAlways).toEqual([...PLATFORM_DENY_ALWAYS]);
  });

  it("opens unrestricted networking without the gateway when there are no substitutions", () => {
    const rules = compileFirewall({ scope, networking: { type: "unrestricted" }, substitutions: [] }, platform);
    expect(rules).toMatchObject({ mode: "open", allowHosts: [], allowCidrs: [], includesGateway: false });
  });

  it("compiles limited networking into a normalized allowlist plus channels", () => {
    const rules = compileFirewall(limited(), platform);
    expect(rules.mode).toBe("allowlist");
    expect(rules.includesGateway).toBe(false);
    expect(rules.allowHosts).toEqual(["*.npmjs.org", "api.github.com", "files.example.com", "mcp.example.com", "pypi.org"]);
    expect(allowsHost(rules, "registry.npmjs.org")).toBe(true);
    expect(allowsHost(rules, "npmjs.org")).toBe(false);
    expect(allowsHost(rules, "evil.example.com")).toBe(false);
    expect(allowsHost(rules, "metadata.google.internal")).toBe(false);
  });

  it("adds the gateway to a limited allowlist only when there are substitutions", () => {
    const rules = compileFirewall(limited([{ credentialId: "cred", envName: "TOKEN", placeholder: "ph", hosts: ["api.github.com"], inject: { header: true, body: false } }]), platform);
    expect(rules.includesGateway).toBe(true);
    expect(rules.allowHosts).toContain("gw.example.com");
    expect(rules.allowCidrs).toEqual(["203.0.113.7/32"]);
  });

  it("rejects IP literals in limited networking and malformed patterns", () => {
    const policy = limited();
    if (policy.networking.type !== "limited") throw new Error("unreachable");
    policy.networking.hosts.push("10.0.0.1");
    expect(() => compileFirewall(policy, platform)).toThrow(/IP literals/);
    expect(() => normalizeHostPattern("https://example.com")).toThrow(TypeError);
    expect(() => normalizeHostPattern("a.*.example.com")).toThrow(TypeError);
  });

  it("matches wildcards against subdomains only", () => {
    expect(matchesHostPattern("a.b.example.com", "*.example.com")).toBe(true);
    expect(matchesHostPattern("example.com", "*.example.com")).toBe(false);
    expect(matchesHostPattern("bücher.example", "xn--bcher-kva.example")).toBe(true);
  });
});
