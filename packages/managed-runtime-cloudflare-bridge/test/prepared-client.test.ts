import { expect, it } from "vitest";
import * as bridge from "../src/index";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store/adapters/in-memory";

const firewall = { mode: "allowlist", allowHosts: ["registry.npmjs.org"], allowCidrs: [], denyAlways: ["169.254.169.254/32", "fd00:ec2::254/128", "100.100.100.200/32", "metadata.google.internal", "127.0.0.0/8", "::1/128"], includesGateway: false };
it("prepared client uses authenticated build/firewall/native snapshot routes without changing ordinary provider capability", async () => {
  const calls: any[] = [];
  const image = "registry.example/oma/sandbox@sha256:" + "a".repeat(64);
  const options = { expectedImage: image, baseUrl: "https://bridge.test", apiKey: "host-only", checkpointStore: new InMemoryBlobStore(), fetch: async (input: any, init: any) => {
    const req = new Request(input, init); const body = req.body ? await req.json() : undefined;
    calls.push({ path: new URL(req.url).pathname, method: req.method, auth: req.headers.get("authorization"), body });
    if (req.url.endsWith("/environment-snapshot")) return Response.json({ ref: "owner:token", id: "native", size: 7, image });
    return req.method === "POST" && req.url.endsWith("/v1/sandbox") ? Response.json({ id: "builder" }) : new Response(null, { status: 204 });
  } };
  const client = (bridge as any).createCloudflareBridgePreparedClient(options);
  const runtime = await client.createBuild({ workspaceId: "w", firewall });
  await client.applyBuildFirewall(runtime, firewall);
  expect(await client.snapshotEnvironment(runtime, "prepared")).toEqual({ adapter: "cloudflare-sandbox-bridge", ref: "owner:token" });
  expect(calls).toEqual([
    { path: "/v1/sandbox", method: "POST", auth: "Bearer host-only", body: { purpose: "environment-build", workspace_id: "w", from: { image: "sandbox" }, firewall } },
    { path: "/v1/sandbox/builder/claim", method: "POST", auth: "Bearer host-only", body: {} },
    { path: "/v1/sandbox/builder/firewall", method: "PUT", auth: "Bearer host-only", body: firewall },
    { path: "/v1/sandbox/builder/environment-snapshot", method: "POST", auth: "Bearer host-only", body: { name: "prepared" } },
  ]);
  expect((bridge.createCloudflareBridgeProvider(options) as any).snapshotEnvironment).toBeUndefined();
});

it("prepared restore fails closed without a trusted Session egress binder, before allocation", async () => {
  let allocations = 0;
  const client = (bridge as any).createCloudflareBridgePreparedClient({ expectedImage: "registry.example/oma/sandbox@sha256:" + "a".repeat(64), baseUrl: "https://bridge.test", apiKey: "key", checkpointStore: new InMemoryBlobStore(), fetch: async () => { allocations++; return Response.json({ id: "new" }); } });
  await expect(client.restoreEnvironment({ workspaceId: "w", snapshot: { adapter: "cloudflare-sandbox-bridge", ref: "owner:token" } })).rejects.toThrow("Session egress");
  expect(allocations).toBe(0);
});

it("prepared Session allocation stays deny-all until trusted binder succeeds and restores the exact snapshot", async () => {
  const calls: any[] = []; let bound = false;
  const client = bridge.createCloudflareBridgePreparedClient({ expectedImage: "registry.example/oma/sandbox@sha256:" + "a".repeat(64), baseUrl: "https://bridge.test", apiKey: "key", checkpointStore: new InMemoryBlobStore(), fetch: async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json({ id: "restored" }); } });
  const runtime = await client.restoreEnvironment({ workspaceId: "w", snapshot: { adapter: "cloudflare-sandbox-bridge", ref: "owner:token" }, bindSessionEgress: async runtime => { expect(runtime.runtimeHandle().runtimeId).toBe("restored"); bound = true; } });
  expect(bound).toBe(true); expect(runtime.runtimeHandle().runtimeId).toBe("restored");
  expect(calls).toEqual([{ url: "https://bridge.test/v1/sandbox", body: { purpose: "session", workspace_id: "w", from: { environment_snapshot: "owner:token" } } }, { url: "https://bridge.test/v1/sandbox/restored/claim", body: {} }]);
});

it("maps an authoritative snapshot-gone response without falling back to an unrestricted allocation", async () => {
  let calls = 0;
  const client = bridge.createCloudflareBridgePreparedClient({ expectedImage: "registry.example/oma/sandbox@sha256:" + "a".repeat(64), baseUrl: "https://bridge.test", apiKey: "key", checkpointStore: new InMemoryBlobStore(), fetch: async () => { calls++; return Response.json({ code: "SNAPSHOT_GONE" }, { status: 410 }); } });
  await expect(client.restoreEnvironment({ workspaceId: "w", snapshot: { adapter: "cloudflare-sandbox-bridge", ref: "gone" }, bindSessionEgress: async () => {} })).rejects.toMatchObject({ code: "SNAPSHOT_GONE", status: 410 });
  expect(calls).toBe(1);
});

it("rejects alias configuration and mismatched snapshot provenance instead of trusting response strings", async () => {
  const expectedImage = "registry.example/oma/sandbox@sha256:" + "a".repeat(64);
  const options = { expectedImage, baseUrl: "https://bridge.test", apiKey: "key", checkpointStore: new InMemoryBlobStore() };
  expect(() => bridge.createCloudflareBridgePreparedClient({ ...options, expectedImage: "sandbox" })).toThrow("digest-pinned");
  for (const image of ["sandbox", "registry.example/oma/sandbox@sha256:" + "b".repeat(64)]) {
    const client = bridge.createCloudflareBridgePreparedClient({ ...options, fetch: async (url) => String(url).endsWith("/environment-snapshot")
      ? Response.json({ ref: "owner:token", id: "native", size: 7, image }) : Response.json({ id: "builder" }) });
    const runtime = await client.createBuild({ workspaceId: "w", firewall });
    await expect(client.snapshotEnvironment(runtime, "prepared")).rejects.toThrow("invalid native snapshot");
  }
});
