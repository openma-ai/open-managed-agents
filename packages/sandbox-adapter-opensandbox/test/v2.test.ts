import { afterEach, expect, it, vi } from "vitest";
import * as realSdk from "@alibaba-group/opensandbox";
import { createSandboxPorts } from "@open-managed-agents/sandbox-port-kit";
import { compileFirewall } from "@open-managed-agents/sandbox-port-kit/firewall";
import { mockSdkServer, sandboxInfo } from "./sdk-http";

afterEach(() => vi.unstubAllGlobals());
import type * as SDK from "@alibaba-group/opensandbox";
import { createOpenSandboxV2Adapter } from "../src/v2";
import { optionsFromEnvironment } from "../src/opensandbox";

const scope = { workspaceId: "ws", environmentId: "env", sessionId: "sess", workId: "work" };
const signal = new AbortController().signal;
const plan = { from: { image: "node@sha256:abc" }, egress: null, stores: [], outputs: { bindingId: "out", mountPath: "/mnt/session/outputs" as const }, idleMs: 60_000, labels: { workspaceId: "ws", sessionId: "sess" } };
function fixture(backend: "docker" | "kubernetes" | "fast" = "docker") {
  const clients = new Map<string, any>();
  const snapshots = new Map<string, any>();
  const order: string[] = [];
  let n = 0;
  const client = (args: any) => {
    const id = `sb-${++n}`;
    const c = { id, metadata: args.metadata, status: { state: "Running" },
      commands: { run: vi.fn(async () => ({ logs: { stdout: [{ text: "/project" }], stderr: [] }, result: [], complete: {} })) },
      files: { createDirectories: vi.fn(async () => {}), readBytes: vi.fn(), writeFiles: vi.fn() },
      close: vi.fn(async () => {}), renew: vi.fn(async () => {}),
      credentialVault: { delete: vi.fn(async () => { order.push("revoke"); }), create: vi.fn() },
      getInfo: vi.fn(async () => c),
      pause: vi.fn(async () => { c.status.state = "Paused"; order.push("pause"); }),
      kill: vi.fn(async () => { clients.delete(id); order.push("kill"); }),
    };
    clients.set(id, c); return c;
  };
  const missing = () => Object.assign(new Error("secret upstream body"), { statusCode: 404 });
  const manager = {
    getSandboxInfo: vi.fn(async (id: string) => { if (!clients.has(id)) throw missing(); return clients.get(id); }),
    killSandbox: vi.fn(async (id: string) => { order.push("kill"); clients.delete(id); }),
    createSnapshot: vi.fn(async (id: string) => { order.push("snapshot"); const s = { id: `snap-${snapshots.size}`, sandboxId: id, status: { state: "Ready" } }; snapshots.set(s.id, s); return s; }),
    getSnapshot: vi.fn(async (id: string) => { if (!snapshots.has(id)) throw missing(); return snapshots.get(id); }),
    deleteSnapshot: vi.fn(async (id: string) => { snapshots.delete(id); }),
    renewSandbox: vi.fn(async (_id: string, _seconds: number) => { order.push("renew"); }),
    listSandboxInfos: vi.fn(async () => ({ items: [...clients.values()].map(c => ({ ...c, createdAt: new Date(0) })), pagination: { hasNextPage: false } })),
    close: vi.fn(async () => {}),
  };
  const sdk = { Sandbox: { create: vi.fn(async (args: any) => client(args)), createFromTemplate: vi.fn(async (args: any) => client(args)), connect: vi.fn(async ({ sandboxId }: any) => clients.get(sandboxId)), resume: vi.fn(async ({ sandboxId }: any) => { order.push("resume"); const c = clients.get(sandboxId); c.status.state = "Running"; return c; }) }, SandboxManager: { create: () => manager } };
  const network = { prepare: vi.fn(async (_rules: import("@open-managed-agents/sandbox-port-kit/firewall").FirewallRules) => ({ defaultAction: "deny" as const, egress: [] })), replace: vi.fn(async (_client: SDK.Sandbox, _rules: import("@open-managed-agents/sandbox-port-kit/firewall").FirewallRules) => {}) };
  const options = { sdk: sdk as unknown as typeof SDK, options: optionsFromEnvironment({ OPENSANDBOX_RUNTIME: backend }), deploymentId: "test", network, gateway: { hosts: ["gateway.example"] }, channels: [], fastBase: { image: plan.from.image, templateId: "tpl-1" } };
  return { options, sdk, manager, clients, snapshots, order, network };
}

it("selects native Vault explicitly, enables its proxy at creation, and rejects Fast", async () => {
  const f = fixture();
  const a = createOpenSandboxV2Adapter({ ...f.options, credentialInjection: "provider" });
  expect(a.native?.egress).toBeTypeOf("function");
  expect(createOpenSandboxV2Adapter(f.options).native?.egress).toBeUndefined();
  await a.lifecycle.acquire({ scope, plan, signal });
  expect(f.sdk.Sandbox.create.mock.calls[0]?.[0]).toMatchObject({ credentialProxy: { enabled: true } });
  const fast = fixture("fast");
  expect(() => createOpenSandboxV2Adapter({ ...fast.options, credentialInjection: "provider" })).toThrow(/Fast/);
});

it("revokes native provider secrets before snapshots and refuses capture on revocation failure", async () => {
  const f = fixture(); const a = createOpenSandboxV2Adapter({ ...f.options, credentialInjection: "provider" });
  const acquired = await a.lifecycle.acquire({ scope, plan, signal }); if (acquired === "gone") throw new Error();
  await a.lifecycle.checkpoint({ scope, ...acquired, signal });
  expect(f.order).toEqual(["revoke", "snapshot"]);
  f.clients.get(acquired.handle.runtimeId).credentialVault.delete.mockRejectedValueOnce(new Error("upstream secret"));
  await expect(a.lifecycle.snapshotTemplate({ ...acquired, signal })).rejects.toThrow(/revocation failed/);
  expect(f.manager.createSnapshot).toHaveBeenCalledTimes(1);
});

it("refuses attaching a handle created with a different credential injection mode", async () => {
  const f = fixture(); const a = createOpenSandboxV2Adapter(f.options);
  const acquired = await a.lifecycle.acquire({ scope, plan, signal }); if (acquired === "gone") throw new Error();
  const native = createOpenSandboxV2Adapter({ ...f.options, credentialInjection: "provider" });
  await expect(native.lifecycle.attach({ scope, handle: acquired.handle, signal })).rejects.toThrow(/reference/);
});

it("requires explicit backend, network enforcement and rejects shared volume claims", () => {
  const f = fixture();
  expect(() => createOpenSandboxV2Adapter({ ...f.options, options: optionsFromEnvironment({}) })).toThrow(/backend|RUNTIME/);
  expect(() => createOpenSandboxV2Adapter({ ...f.options, network: undefined as never })).toThrow(/network/i);
  expect(() => createOpenSandboxV2Adapter({ ...f.options, options: { ...f.options.options, volumes: [{ name: "shared", mountPath: "/workspace", host: { path: "/data" } }] } })).toThrow(/volume/i);
});

it.each(["docker", "kubernetes", "fast"] as const)("%s snapshots before pausing and restores expired compute with a new scoped handle", async backend => {
  const f = fixture(backend); const a = createOpenSandboxV2Adapter(f.options);
  const acquired = await a.lifecycle.acquire({ scope, plan, signal });
  if (acquired === "gone") throw new Error("unexpected gone");
  expect(a.lifecycle.handle).toBe("changes");
  expect(acquired.handle.metadata).toMatchObject({ backend, deploymentId: "test", workspaceId: "ws", sessionId: "sess" });
  const ref = await a.lifecycle.pause({ scope, ...acquired, signal });
  expect(f.order).toEqual(["snapshot", "pause"]);
  // Model provider TTL expiry while paused, not an adapter-triggered delete.
  f.clients.delete(acquired.handle.runtimeId);
  expect(await a.lifecycle.attach({ scope, handle: acquired.handle, signal })).toBe("gone");
  const restored = await a.lifecycle.resume({ scope, ref, plan, signal });
  expect(restored).not.toBe("gone");
  if (restored === "gone") return;
  expect(restored.handle.runtimeId).not.toBe(acquired.handle.runtimeId);
  expect(f.sdk.Sandbox.create.mock.calls.at(-1)?.[0]).toMatchObject({ snapshotId: ref.ref, networkPolicy: { defaultAction: "deny" } });
  await a.lifecycle.discard({ scope, ref });
  expect(f.snapshots.size).toBe(0);
});

it.each(["docker", "kubernetes", "fast"] as const)("%s reattaches a paused handle without allocating unrelated compute", async backend => {
  const f = fixture(backend); const a = createOpenSandboxV2Adapter(f.options);
  const acquired = await a.lifecycle.acquire({ scope, plan, signal }); if (acquired === "gone") throw new Error();
  await a.lifecycle.pause({ scope, ...acquired, signal });
  const restored = await a.lifecycle.attach({ scope, handle: acquired.handle, signal });
  expect(restored).not.toBe("gone");
  if (restored !== "gone") expect(restored.handle).toEqual(acquired.handle);
  expect(f.order).toEqual(backend === "fast" ? ["snapshot", "pause", "renew", "resume"] : ["snapshot", "pause", "resume"]);
  expect(f.clients.size).toBe(1);
});

it("templates restore only within the same workspace, but may start another session", async () => {
  const f = fixture(); const a = createOpenSandboxV2Adapter(f.options);
  const acquired = await a.lifecycle.acquire({ scope, plan, signal }); if (acquired === "gone") throw new Error();
  const template = await a.lifecycle.snapshotTemplate({ ...acquired, signal });
  const second = { ...scope, sessionId: "second" };
  expect(await a.lifecycle.acquire({ scope: second, plan: { ...plan, labels: { workspaceId: "ws", sessionId: "second" }, from: { template } }, signal })).not.toBe("gone");
  await expect(a.lifecycle.acquire({ scope: { ...scope, workspaceId: "other" }, plan: { ...plan, from: { template } }, signal })).rejects.toThrow(/reference/);
});

it("returns gone for deleted snapshots and handles, but maps provider throttling", async () => {
  const f = fixture(); const a = createOpenSandboxV2Adapter(f.options);
  const acquired = await a.lifecycle.acquire({ scope, plan, signal }); if (acquired === "gone") throw new Error();
  f.manager.getSandboxInfo.mockRejectedValueOnce(Object.assign(new Error(), { statusCode: 404 }));
  expect(await a.lifecycle.attach({ scope, handle: acquired.handle, signal })).toBe("gone");
  f.clients.get(acquired.handle.runtimeId).renew.mockRejectedValueOnce(Object.assign(new Error(), { statusCode: 429 }));
  await expect(a.lifecycle.keepAlive(acquired)).rejects.toMatchObject({ name: "RetryableSandboxError" });
  const ref = await a.lifecycle.checkpoint({ scope, ...acquired, signal });
  f.sdk.Sandbox.create.mockRejectedValueOnce(Object.assign(new Error(), { statusCode: 404 }));
  expect(await a.lifecycle.resume({ scope, ref, plan, signal })).toBe("gone");
});

it("does not call an expired terminal runtime alive just because renewal succeeds", async () => {
  const f = fixture(); const a = createOpenSandboxV2Adapter(f.options);
  const acquired = await a.lifecycle.acquire({ scope, plan, signal }); if (acquired === "gone") throw new Error();
  f.clients.get(acquired.handle.runtimeId).status.state = "Terminated";
  expect(await a.lifecycle.keepAlive(acquired)).toBe("gone");
});

it("does not stop compute when snapshot creation fails", async () => {
  const f = fixture(); const a = createOpenSandboxV2Adapter(f.options);
  const acquired = await a.lifecycle.acquire({ scope, plan, signal }); if (acquired === "gone") throw new Error();
  f.manager.createSnapshot.mockRejectedValueOnce(Object.assign(new Error("busy secret"), { statusCode: 503 }));
  await expect(a.lifecycle.pause({ scope, ...acquired, signal })).rejects.toMatchObject({ name: "RetryableSandboxError" });
  expect(f.clients.has(acquired.handle.runtimeId)).toBe(true);
});

it("refuses foreign handles, backend changes, and cross-session refs before contacting the provider", async () => {
  const f = fixture(); const a = createOpenSandboxV2Adapter(f.options);
  const acquired = await a.lifecycle.acquire({ scope, plan, signal }); if (acquired === "gone") throw new Error();
  for (const metadata of [{ ...acquired.handle.metadata, backend: "fast" }, { ...acquired.handle.metadata, sessionId: "other" }]) {
    await expect(a.lifecycle.attach({ scope, handle: { ...acquired.handle, metadata }, signal })).rejects.toThrow(/reference/i);
  }
  expect(f.manager.getSandboxInfo).not.toHaveBeenCalled();
});

it("fails closed before allocation when network enforcement cannot represent the policy", async () => {
  const f = fixture(); const a = createOpenSandboxV2Adapter(f.options);
  f.network.prepare.mockRejectedValueOnce(new Error("CIDR enforcement unavailable"));
  await expect(a.lifecycle.acquire({ scope, plan, signal })).rejects.toThrow(/CIDR/);
  expect(f.sdk.Sandbox.create).not.toHaveBeenCalled();
});

it("passes hard denies, gateway and narrowed allowed hosts to network enforcement", async () => {
  const f = fixture(); const a = createOpenSandboxV2Adapter(f.options);
  const policy = { scope: { workspaceId: "ws", sessionId: "sess", generation: 1 }, networking: { type: "limited" as const, hosts: ["*.example.com"], packageSources: ["registry.npmjs.org"], mcpHosts: [] }, substitutions: [] };
  const acquired = await a.lifecycle.acquire({ scope, plan: { ...plan, egress: policy }, signal }); if (acquired === "gone") throw new Error();
  expect(f.network.prepare.mock.calls[0]?.[0]).toMatchObject({ mode: "allowlist", allowHosts: ["*.example.com", "registry.npmjs.org"], denyAlways: expect.arrayContaining(["169.254.169.254/32", "fd00:ec2::254/128"]) });
  const narrowed = compileFirewall({ ...policy, networking: { ...policy.networking, hosts: [], packageSources: [] } }, { gateway: f.options.gateway, channels: [] });
  await a.vendor.applyFirewall!(acquired.runtime, narrowed);
  expect(f.network.replace.mock.calls.at(-1)?.[1]).toMatchObject({ mode: "allowlist", allowHosts: [] });
});

it("uses the generic v2 storage port, not a claimed persistent provider mount", () => {
  const f = fixture(); const a = createOpenSandboxV2Adapter(f.options);
  const { ports } = createSandboxPorts(a, { storage: { memories: vi.fn(), outputs: { read: async function* () {}, publish: vi.fn() }, authorize: async () => false }, egress: { gateway: { endpoint: { url: "https://gateway.example" }, issueToken: vi.fn(), authenticate: vi.fn(), handle: vi.fn() } } });
  expect(ports.sandbox).toBe(a.lifecycle);
  expect(ports.storage.attach).toBeTypeOf("function");
  expect(a.native?.storage).toBeUndefined();
});

it("maps native Vault requests through the real SDK and keeps plaintext out of sandbox commands", async () => {
  const f = fixture(); const server = mockSdkServer();
  server.override = request => request.url.pathname.endsWith("/credential-vault") && request.method === "POST"
    ? Response.json({ revision: 1, credentials: [], bindings: [] }) : undefined;
  const a = createOpenSandboxV2Adapter({ ...f.options, sdk: realSdk, credentialInjection: "provider" });
  const acquired = await a.lifecycle.acquire({ scope, plan, signal }); if (acquired === "gone") throw new Error();
  const { ports } = createSandboxPorts(a, { storage: {} as never, egress: { secrets: { read: async () => ({ value: "native-secret", expiresAt: null }) }, gateway: { endpoint: { url: "https://gateway.example" }, issueToken: vi.fn(), authenticate: vi.fn(), handle: vi.fn() } } });
  const fence = { ...scope, ownerId: "owner", generation: 1, token: "token", expiresAt: "2030-01-01T00:00:00Z" };
  try {
    await ports.egress.attach({ ...acquired, scope, fence, signal, policy: { scope: { workspaceId: "ws", sessionId: "sess", generation: 1 }, networking: { type: "unrestricted" }, substitutions: [{ credentialId: "cred", envName: "TOKEN", placeholder: "placeholder", hosts: ["api.example"], inject: { header: false, body: true } }] } });
    const call = server.calls.find(c => c.method === "POST" && c.url.pathname.endsWith("/credential-vault"));
    expect(call?.body).toMatchObject({ credentials: [{ source: { value: "native-secret" } }], bindings: [{ auth: { substitutions: [{ in: ["body"] }] } }] });
    expect(acquired.runtime.commandEnv("node")).toEqual({ TOKEN: "placeholder" });
    expect(JSON.stringify(server.calls.filter(c => c.url.pathname.endsWith("/command")))).not.toContain("native-secret");
    await ports.egress.revoke({ ...acquired, scope, fence, reason: "checkpoint" });
    expect(server.calls.filter(c => c.method === "DELETE" && c.url.pathname.endsWith("/credential-vault"))).toHaveLength(2);
  } finally { await acquired.runtime.destroy(); }
});

it("serializes ownership and creation-time policy through the real SDK", async () => {
  const f = fixture(); const server = mockSdkServer();
  server.override = request => request.url.pathname.endsWith("/sandboxes") && request.method === "POST"
    ? Response.json({ ...sandboxInfo(), metadata: (request.body as any).metadata }, { status: 202 }) : undefined;
  const a = createOpenSandboxV2Adapter({ ...f.options, sdk: realSdk });
  const acquired = await a.lifecycle.acquire({ scope, plan, signal }); if (acquired === "gone") throw new Error();
  try {
    expect(server.calls.find(c => c.method === "POST" && c.url.pathname.endsWith("/sandboxes"))?.body).toMatchObject({ image: { uri: plan.from.image }, networkPolicy: { defaultAction: "deny" }, metadata: { "oma-workspace": "ws", "oma-session": "sess", "oma-backend": "docker", "oma-deployment": "test" } });
  } finally { await acquired.runtime.destroy(); }
});

it("Fast requires an explicit image-to-template binding, never silently ignores the image", async () => {
  const f = fixture("fast"); const a = createOpenSandboxV2Adapter(f.options);
  await expect(a.lifecycle.acquire({ scope, plan: { ...plan, from: { image: "other" } }, signal })).rejects.toThrow(/image/i);
  expect(f.sdk.Sandbox.createFromTemplate).not.toHaveBeenCalled();
});

it("lists only exact deployment/backend ownership and keeps labels lossless", async () => {
  const f = fixture(); const a = createOpenSandboxV2Adapter(f.options);
  await a.lifecycle.acquire({ scope, plan, signal });
  const result = await a.lifecycle.list({ labels: plan.labels, signal });
  expect(result).toHaveLength(1);
  expect(result[0]?.labels).toEqual(plan.labels);
  await expect(a.lifecycle.acquire({ scope, plan: { ...plan, labels: { ...plan.labels, sessionId: "bad/label" } }, signal })).rejects.toThrow();
});
