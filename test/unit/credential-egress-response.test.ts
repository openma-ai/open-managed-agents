import { describe, expect, it } from "vitest";
import { buildCredentialEgressRoutes } from "../../packages/managed-agents-adapters-http/src/credential-egress";
import { createCredentialEgressRelay, createEgressRelayPasses } from "../../packages/managed-credential-resolver/src/relay";

// Exercise the same HTTP boundary in workerd, independent of Node's Response.
describe("Cloudflare relay response framing", () => {
  it.each([
    { method: "HEAD", status: 200, length: "123", metadata: "123" },
    { method: "GET", status: 204, length: null, metadata: null },
    { method: "GET", status: 205, length: "0", metadata: null },
    { method: "GET", status: 304, length: "123", metadata: null },
  ])("preserves $method $status bodylessness without false POST length", async ({ method, status, length, metadata }) => {
    const passes = createEgressRelayPasses("response-fixture", Date.now);
    const relay = createCredentialEgressRelay({
      passes, findSession: async () => ({ vaultIds: ["vault"], archivedAt: null }),
      credentials: {
        outboundTarget: async () => ({ type: "raw_bearer", token: "fixture-token" }),
        forward: async (_workspace, _target, send) => ({ response: await send("fixture-token") }),
      } as never,
      send: async () => new Response(null, { status, headers: length === null ? {} : { "content-length": length } }),
    });
    const response = await buildCredentialEgressRoutes(() => relay).request("https://control.example/forward", { method: "POST", headers: {
      authorization: `Bearer ${await passes.issue({ workspaceId: "workspace", sessionId: "session", ttlMs: 60000 })}`,
      "x-oma-egress-target": "https://upstream.example/", "x-oma-egress-method": method,
    } });
    expect(response.status).toBe(status); expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe(method === "HEAD" ? null : length);
    expect(response.headers.get("x-oma-egress-head-content-length")).toBe(metadata);
  });
});
