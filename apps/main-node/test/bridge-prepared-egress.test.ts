import { expect, it } from "vitest";
import { createNodeBridgePreparedEgress } from "../../../packages/control-plane-node/src/lib/node-bridge-prepared-egress";

const scope = { workspaceId: "w", sessionId: "s", environmentId: "e", workId: "work" };
const fence = { ...scope, ownerId: "owner", generation: 1 };
const policy = { scope: { workspaceId: "w", sessionId: "s", generation: 1 }, networking: { type: "limited" as const, hosts: ["api.example.test"], packageSources: [], mcpHosts: [] }, substitutions: [] };
function fixture() {
  const calls: any[] = []; const runtime = {};
  const port = createNodeBridgePreparedEgress({ apply: async input => { calls.push(input); }, authorize: async () => true });
  return { port, calls, runtime };
}
it("existing native egress Port compiles Session allowlist and revokes back to deny-all", async () => {
  const f = fixture();
  await f.port.attach({ runtime: f.runtime, scope, fence, policy, signal: new AbortController().signal });
  expect(f.calls[0]).toMatchObject({ runtime: f.runtime, workspaceId: "w", rules: { mode: "allowlist", allowHosts: ["api.example.test"], allowCidrs: [], includesGateway: false } });
  await f.port.revoke({ runtime: f.runtime, scope, fence, reason: "completed" });
  expect(f.calls[1].rules).toMatchObject({ mode: "allowlist", allowHosts: [], allowCidrs: [], includesGateway: false });
});
it("stale execution cannot bind or revoke a newer owner's network", async () => {
  let effects = 0;
  const port = createNodeBridgePreparedEgress({ apply: async () => { effects++; }, authorize: async () => false });
  await expect(port.attach({ runtime: {}, scope, fence, policy, signal: new AbortController().signal })).rejects.toThrow("fence");
  await expect(port.revoke({ runtime: {}, scope, fence, reason: "lease_lost" })).rejects.toThrow("fence");
  expect(effects).toBe(0);
});
it("does not reinterpret unrestricted or credentialed networking as a supported public allowlist", async () => {
  const f = fixture();
  for (const unsupported of [null, { ...policy, networking: { type: "unrestricted" as const } }, { ...policy, substitutions: [{ credentialId: "c", envName: "KEY", placeholder: "p", hosts: ["api.example.test"], inject: { header: true, body: false } }] }]) {
    await expect(f.port.attach({ runtime: f.runtime, scope, fence, policy: unsupported, signal: new AbortController().signal })).rejects.toThrow("public allowlist");
  }
  expect(f.calls).toHaveLength(0);
});

it("rejects a policy or fence from another Session before touching the native firewall", async () => {
  const f = fixture();
  await expect(f.port.attach({ runtime: f.runtime, scope, fence, policy: { ...policy, scope: { ...policy.scope, sessionId: "foreign" } }, signal: new AbortController().signal })).rejects.toThrow("scope");
  await expect(f.port.attach({ runtime: f.runtime, scope, fence: { ...fence, workspaceId: "foreign" }, policy, signal: new AbortController().signal })).rejects.toThrow("scope");
  expect(f.calls).toHaveLength(0);
});
