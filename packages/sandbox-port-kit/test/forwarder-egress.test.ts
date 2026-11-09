import { attemptSandboxTokens } from "../../sandbox-gateway/src/attempt-sandbox-token";
import { describe, expect, it } from "vitest";
import type { EgressPolicy } from "@open-managed-agents/sandbox";
import { createForwarderEgress } from "../src/forwarder-egress";
import { repositoryChannels, type FirewallRules } from "../src/firewall";
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

describe("relay pass binding (design §0.0 rule 10)", () => {
  it("repeated attach and policy update on one runtime and attempt share one issuance; a replacement runtime reissues", async () => {
    const bindings: string[] = [];
    const runtime = {
      exec: async (command: string) => command.includes("EGRESS_DIR:") ? "EGRESS_DIR:/workspace/.oma-egress" : command.includes("echo EGRESS_DELIVERED") ? "EGRESS_DELIVERED" : command.includes("EGRESS_READY:") ? 'EGRESS_READY:{"pid":123,"port":18080,"caFile":"/workspace/ca.pem","caBundleFile":"/workspace/ca-bundle.pem"}' : "",
      readFile: async () => "",
      writeFile: async (path: string, content: string) => { if (path.endsWith(".next.json")) bindings.push(JSON.parse(content).token); return path; },
      setEnvVars: async () => {},
    };
    let issued = 0;
    const holder = attemptSandboxTokens();
    const egress = createForwarderEgress({ ...vendor([]), asSandboxPort: () => runtime }, {
      gateway: { ...deps.gateway, issueToken: async ({ attempt, sandbox }) => holder.relayDelivery(attempt!, async () => "token-" + ++issued, sandbox) },
    });
    const policy = { ...limited, substitutions: [{ credentialId: "vault:TOKEN", envName: "TOKEN", placeholder: "oma_ph_1", hosts: [], inject: { header: true, body: false } }] };
    const input = { runtime, scope, fence, policy, signal };
    await egress.attach(input);
    await Promise.all([egress.attach(input), egress.attach(input)]);
    await egress.update({ ...input, changedCredentialIds: ["vault:TOKEN"] });
    expect(new Set(bindings)).toEqual(new Set(["token-1"]));
    expect(issued).toBe(1);
    await egress.attach({ ...input, runtime: { ...runtime } });
    expect(bindings.at(-1)).toBe("token-2");
    await egress.attach({ ...input, fence: { ...fence, token: "next-attempt" } });
    expect(bindings.at(-1)).toBe("token-3");
  });

  const withVault: EgressPolicy = {
    ...limited,
    substitutions: [{ envName: "TOKEN", placeholder: "__p__", credentialId: "vault", hosts: ["api.example.com"] }] as never,
  };
  const attachWith = async (attachFence: typeof fence) => {
    const issued: unknown[] = [];
    const egress = createForwarderEgress(vendor([]), {
      gateway: { ...deps.gateway, issueToken: async (input) => { issued.push(input.attempt); return "pass"; } },
    });
    await egress.attach({ runtime: {}, scope, fence: attachFence, policy: withVault, signal }).catch(() => undefined);
    return issued;
  };

  it("issues the pass for the execution attempt the fence carries", async () => {
    expect(await attachWith({ ...fence, workId: "exe", ownerId: "owner", generation: 4, token: "att" })).toEqual([
      { workspaceId: "ws", sessionId: "sess", executionId: "exe", attemptId: "att", ownerId: "owner", generation: 4 },
    ]);
  });

  it("issues with no attempt under the placeholder fence", async () => {
    expect(await attachWith({ ...fence, ownerId: "session-do", token: "session-do" })).toEqual([null]);
  });
});

describe("platform channels (design §0.6: limited + github_repository)", () => {
  it("adds the composition's channels, e.g. the attached repository's host, to the limited allowlist", async () => {
    const applied: FirewallRules[] = [];
    const resources = [
      { type: "github_repository", url: "https://github.com/acme/app.git" },
      { type: "github_repo", repo_url: "https://GitHub.com/acme/other" },
      { type: "memory_store" },
    ];
    const channels: string[] = [];
    const egress = createForwarderEgress(vendor(applied), {
      ...deps,
      channels: (input) => { channels.push(input.sessionId); return repositoryChannels(resources); },
    });
    await egress.attach({ runtime: {}, scope, fence, policy: limited, signal });
    expect(channels).toEqual(["sess"]);
    expect(applied[0]).toMatchObject({ mode: "allowlist", allowHosts: ["api.example.com", "github.com"] });
  });

  it("repositoryChannels keeps only repository URL hosts", () => {
    expect(repositoryChannels([
      { type: "github_repository", url: "https://github.example.com/a/b" },
      { type: "github_repository", url: "not a url" },
      { type: "github_repository", url: "ssh://git@github.com/a/b" },
      { type: "file", url: "https://files.example.com/x" },
    ])).toEqual(["github.example.com"]);
  });
});

describe("relay installation on a v1 runtime (v1 bridges)", () => {
  it("installs on the runtime itself, so its own path mapping and exec are used", async () => {
    const ownCalls: string[] = [];
    const runtime = {
      async exec(command: string) { ownCalls.push(`exec:${command.split(" ")[0]}`); return "exit=1\n"; },
      async readFile() { return ""; },
      async writeFile(path: string) { ownCalls.push(`writeFile:${path}`); return `/host/mapped${path}`; },
    };
    const primitives: string[] = [];
    const egress = createForwarderEgress<typeof runtime>({
      async exec() { primitives.push("exec"); return { exitCode: 0, stdout: "", stderr: "" }; },
      async readFile() { primitives.push("readFile"); return null; },
      async writeFile() { primitives.push("writeFile"); },
      async setEnv() { primitives.push("setEnv"); },
      asSandboxPort: (own) => own,
    }, deps);
    const withVault: EgressPolicy = { ...limited, substitutions: [{ credentialId: "vault:TOKEN", envName: "TOKEN", placeholder: "oma_ph_1", hosts: [], inject: { header: true, body: false } }] };
    // The fake runtime cannot create the relay directory; what matters is who was asked.
    await expect(egress.attach({ runtime, scope, fence, policy: withVault, signal })).rejects.toThrow();
    expect(ownCalls[0]).toBe("exec:mkdir");
    expect(primitives).toEqual([]);
  });
});
