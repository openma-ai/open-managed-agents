import { expect, it } from "vitest";
import { Sandbox } from "@alibaba-group/opensandbox";
import { OpenSandbox, optionsFromEnvironment } from "../src/opensandbox";
import { createOpenSandboxNativeEgress } from "../src/native-egress";

// Explicit opt-in: creates one Docker sandbox and sends only synthetic tokens
// to the public httpbin echo service. Not a full network-controller certification.
it.skipIf(process.env.OMA_NATIVE_VAULT_LOCAL !== "1")("injects, rotates and revokes a synthetic native Vault credential over real HTTPS", async () => {
  const options = optionsFromEnvironment(process.env);
  const client = await Sandbox.create({
    image: "node:22-slim", timeoutSeconds: 600,
    connectionConfig: { domain: options.domain, protocol: options.protocol, useServerProxy: true, disableMetrics: true },
    readyTimeoutSeconds: 120,
    networkPolicy: { defaultAction: "deny", egress: [{ action: "allow", target: "httpbin.org" }] },
    credentialProxy: { enabled: true },
    entrypoint: ["tail", "-f", "/dev/null"],
    metadata: { "oma-test": "native-vault-local" },
  });
  const runtime = new OpenSandbox(client, options);
  const scope = { workspaceId: "test", sessionId: "test", environmentId: "test", workId: "test" };
  const fence = { ...scope, ownerId: "test", generation: 1, token: "test", expiresAt: "2030-01-01T00:00:00Z" };
  let value = "oma-local-synthetic-one";
  const port = createOpenSandboxNativeEgress<OpenSandbox>({
    exec: async () => { throw new Error("unexpected exec"); }, readFile: async () => null, writeFile: async () => {},
    setEnv: (r, env) => r.setEnvVars(env),
    // Test only: this run never changes the network policy. Assert the actual
    // sidecar policy rather than pretending to certify an enforcement adapter.
    applyFirewall: async () => {
      expect(await client.getEgressPolicy()).toMatchObject({ defaultAction: "deny", egress: expect.arrayContaining([{ action: "allow", target: "httpbin.org" }]) });
    },
  }, () => client.credentialVault, { secrets: { read: async () => ({ value, expiresAt: null }) }, gateway: {
    endpoint: { url: "https://unused.example" }, issueToken: async () => "", authenticate: async () => null, handle: async () => new Response(),
  } });
  const input = { runtime, scope, fence, signal: new AbortController().signal, policy: {
    scope: { workspaceId: "test", sessionId: "test", generation: 1 }, networking: { type: "limited" as const, hosts: ["httpbin.org"], packageSources: [], mcpHosts: [] },
    substitutions: [{ credentialId: "test", envName: "TEST_TOKEN", placeholder: "oma-placeholder", hosts: ["httpbin.org"], inject: { header: true, body: false } }],
  } };
  const echo = async () => {
    const result = await runtime.exec(`node -e 'fetch("https://httpbin.org/headers",{headers:{"X-Oma-Test":"oma-placeholder"},signal:AbortSignal.timeout(20000)}).then(async r=>{if(!r.ok)throw Error("HTTP "+r.status); console.log(await r.text())}).catch(e=>{console.error(e,e.cause);process.exit(1)})'`, 30_000);
    expect(result).not.toContain("[exit");
    return JSON.parse(result).headers["X-Oma-Test"];
  };
  try {
    console.log("LOCAL_SANDBOX", client.id);
    await client.files.createDirectories([{ path: "/workspace", mode: 755 }]);
    await port.attach(input);
    expect(await runtime.exec("printenv TEST_TOKEN")).toBe("oma-placeholder");
    expect(await echo()).toBe(value);
    value = "oma-local-synthetic-two";
    await port.update({ ...input, changedCredentialIds: ["test"] });
    expect(await echo()).toBe(value);
    await port.revoke({ ...input, reason: "checkpoint" });
    expect(await echo()).toBe("oma-placeholder");
    const blocked = await runtime.exec(`node -e 'fetch("https://example.com",{signal:AbortSignal.timeout(5000)}).then(r=>console.log("STATUS",r.status)).catch(()=>console.log("BLOCKED"))'`, 10_000);
    expect(blocked.trim()).toMatch(/^(BLOCKED|STATUS 403)$/);
    // TCP connect alone is not proof of bypass: transparent MITM accepts the
    // socket before evaluating the destination. Check application response.
    const direct = await runtime.exec(`node -e 'const timer=setTimeout(()=>{console.log("BLOCKED");process.exit(0)},5000);const r=require("node:https").get("https://1.1.1.1",{rejectUnauthorized:false},s=>{clearTimeout(timer);console.log("STATUS",s.statusCode);s.resume();process.exit(0)});r.on("error",()=>{clearTimeout(timer);console.log("BLOCKED");process.exit(0)})'`, 10_000);
    expect(direct.trim()).toMatch(/^(STATUS 403|BLOCKED(?:\\nBLOCKED)?)$/);
    console.log("LOCAL_NATIVE_VAULT_VERIFIED: injection rotation revocation and non-allowed domain");
  } finally {
    try { await client.kill(); } finally { await client.close(); }
  }
}, 240_000);
