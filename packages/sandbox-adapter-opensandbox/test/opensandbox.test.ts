import { afterEach, describe, expect, it, vi } from "vitest";
import { Sandbox as SdkSandbox } from "@alibaba-group/opensandbox";
import { OpenSandbox, optionsFromEnvironment, sandboxProvider } from "../src/index";
import { completed, mockSdkServer } from "./sdk-http";

const ctx = { sessionId: "session-test", workdir: "/workspace" };
const env = { OPENSANDBOX_DOMAIN: "control.test:8080", OPENSANDBOX_API_KEY: "provider-secret" };
const allocations: OpenSandbox[] = [];
async function create(extra = {}) {
  const sandbox = await sandboxProvider.create(ctx, { ...env, ...extra });
  allocations.push(sandbox);
  return sandbox;
}
afterEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  await Promise.all(allocations.splice(0).map(sandbox => sandbox.destroy().catch(() => undefined)));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenSandbox official SDK adapter", () => {
  it("creates, executes and transfers binary files through the real SDK", async () => {
    const server = mockSdkServer();
    server.commands = [{ type: "stdout", text: "hello\n" }, { type: "stderr", text: "warning\n" }, completed];
    const sandbox = await create();
    expect(sandbox.runtimeHandle()).toEqual({ provider: "opensandbox", runtimeId: "sb-1" });
    expect(sandbox.runtimeCapabilities()).toEqual({ lease: true, suspend: ["filesystem", "memory"], checkpoint: ["filesystem"] });
    await sandbox.setEnvVars({ COMMON: "yes" });
    sandbox.registerCommandSecrets("git", { TOKEN: "scoped-secret" });
    expect(await sandbox.exec("git status", 1234)).toBe("hello\nwarning");
    expect(await sandbox.writeFile("nested/hello.txt", "héllo")).toBe("/workspace/nested/hello.txt");
    expect(await sandbox.writeFileBytes("/workspace/raw.bin", Uint8Array.of(0, 255, 1))).toBe("/workspace/raw.bin");
    expect(await sandbox.readFileBytes("raw.bin")).toEqual(Uint8Array.of(0, 255, 1));
    expect(await sandbox.readFile("raw.bin")).toBe("\0�\x01");
    await sandbox.renewLease({ ttlMs: 60_000 });
    const creation = server.calls.find(call => call.url.pathname.endsWith("/sandboxes") && call.method === "POST")!;
    expect(creation.body).toMatchObject({
      image: { uri: "node:22-slim" }, timeout: 1800,
      resourceLimits: { cpu: "1", memory: "1Gi" },
      entrypoint: ["tail", "-f", "/dev/null"], metadata: { "oma-session-id": "session-test" },
      env: {},
    });
    expect(creation.headers.get("OPEN-SANDBOX-API-KEY")).toBe("provider-secret");
    expect(server.calls.find(call => call.url.pathname === "/command")!.body).toEqual({
      command: "git status", timeout: 1234, background: false, cwd: "/workspace", envs: { COMMON: "yes", TOKEN: "scoped-secret" },
    });
    for (const call of server.calls.filter(call => call.url.hostname === "exec.test")) {
      expect(call.headers.has("OPEN-SANDBOX-API-KEY")).toBe(false);
      expect(call.headers.get("X-EXECD-ACCESS-TOKEN")).toBe("runtime-token");
      expect(JSON.stringify(call.body) ?? "").not.toContain("provider-secret");
    }
    const upload = server.calls.filter(call => call.url.pathname === "/files/upload").at(-1)!.body as FormData;
    const metadata = upload.get("metadata") as File;
    expect(metadata).toBeInstanceOf(Blob);
    expect(metadata.name).toBeTruthy();
    expect(metadata.type).toBe("application/json");
    expect(JSON.parse(await metadata.text())).toEqual({ path: "/workspace/raw.bin", mode: 644 });
    expect(new Uint8Array(await (upload.get("file") as Blob).arrayBuffer())).toEqual(Uint8Array.of(0, 255, 1));
    expect(server.calls.some(call => call.url.pathname.endsWith("/renew-expiration"))).toBe(true);
  });

  it.each(["sse", "json"] as const)("delegates fragmented %s command streams to the SDK and still rejects truncation", async format => {
    const server = mockSdkServer();
    server.format = format;
    server.commands = [{ type: "stdout", text: "héllo\n" }, completed];
    const sandbox = await create();
    expect(await sandbox.exec("printf hello")).toBe("héllo");
    server.commands = [{ type: "stdout", text: "partial" }];
    await expect(sandbox.exec("true")).rejects.toThrow("before execution_complete");
  });

  it("preserves nonzero exits, command startup errors and scoped command environment", async () => {
    const server = mockSdkServer();
    const sandbox = await create();
    for (const code of [2, 3, 7]) {
      server.commands = [{ type: "error", error: { ename: "CommandExecError", evalue: String(code) } }];
      expect(await sandbox.exec("false")).toBe(`\n[exit ${code}]`);
    }
    server.commands = [{ type: "error", error: { evalue: "cannot start" } }, completed];
    await expect(sandbox.exec("missing")).rejects.toThrow("failed to execute");
    await sandbox.setEnvVars({ COMMON: "yes" });
    sandbox.registerCommandSecrets("git", { TOKEN: "private" });
    expect(sandbox.commandEnv("echo hello")).toEqual({ COMMON: "yes" });
    expect(sandbox.commandEnv("git status", { EXTRA: "value", OMIT: undefined })).toEqual({ COMMON: "yes", TOKEN: "private", EXTRA: "value" });
  });

  it("reattaches an existing runtime with the SDK and validates lifecycle handles", async () => {
    const server = mockSdkServer();
    const sandbox = await sandboxProvider.resume({ provider: "opensandbox", runtimeId: "sb-1" }, ctx, env);
    allocations.push(sandbox);
    expect(await sandbox.status()).toBe("running");
    expect(server.calls.some(call => call.method === "POST" && call.url.pathname.endsWith("/sandboxes"))).toBe(false);
    const own = { provider: "opensandbox", checkpointId: "sb-1", sourceRuntimeId: "sb-1", kind: "memory", scope: "runtime" } as const;
    await expect(sandbox.resume({ ...own, checkpointId: "other" })).rejects.toThrow("own runtime-scoped");
    await expect(sandbox.resume({ ...own, scope: "portable" })).rejects.toThrow("own runtime-scoped");
    await expect(sandbox.checkpoint({ kind: "memory" })).rejects.toThrow("filesystem state only");
    await sandbox.resume(own);
    expect(server.calls.some(call => call.url.pathname.endsWith("/resume"))).toBe(false);
    server.state = "Failed";
    await expect(sandbox.resume(own)).rejects.toThrow("cannot be resumed from state stopped");
    await expect(sandboxProvider.resume({ provider: "e2b", runtimeId: "x" }, ctx, env)).rejects.toThrow("Incompatible");
    for (const bad of [{ provider: "e2b" }, { scope: "runtime" }, { kind: "memory" }, { checkpointId: "" }] as const) {
      await expect(sandboxProvider.restore({ provider: "opensandbox", checkpointId: "x", sourceRuntimeId: "x", scope: "portable", kind: "filesystem", ...bad }, ctx, env)).rejects.toThrow("incompatible portable checkpoint");
    }
  });

  it("pauses and resumes the same runtime through the SDK lifecycle API", async () => {
    const server = mockSdkServer();
    const sandbox = await create();
    const checkpoint = await sandbox.suspend({ kind: "memory" });
    expect(checkpoint).toEqual({ provider: "opensandbox", checkpointId: "sb-1", sourceRuntimeId: "sb-1", kind: "memory", scope: "runtime" });
    const pauseAt = server.calls.findIndex(call => call.method === "POST" && call.url.pathname === "/v1/sandboxes/sb-1/pause");
    const extendAt = server.calls.findIndex(call => call.url.pathname === "/v1/sandboxes/sb-1/renew-expiration");
    expect(extendAt).toBeGreaterThanOrEqual(0);
    expect(pauseAt).toBeGreaterThan(extendAt);
    const extended = Date.parse((server.calls[extendAt]!.body as { expiresAt: string }).expiresAt) - Date.now();
    expect(extended).toBeGreaterThan(86_300_000);
    expect(extended).toBeLessThanOrEqual(86_400_000);
    server.state = "Paused";
    expect(await sandbox.status()).toBe("suspended");
    server.override = call => {
      if (call.method === "POST" && call.url.pathname === "/v1/sandboxes/sb-1/resume") { server.state = "Running"; return new Response(null, { status: 204 }); }
      return undefined;
    };
    server.calls.length = 0;
    await sandbox.resume(checkpoint);
    expect(await sandbox.status()).toBe("running");
    const restored = server.calls.find(call => call.url.pathname === "/v1/sandboxes/sb-1/renew-expiration");
    expect(Date.parse((restored!.body as { expiresAt: string }).expiresAt) - Date.now()).toBeLessThanOrEqual(1_800_000);
    expect(await sandbox.readFileBytes("x")).toEqual(Uint8Array.of(0, 255, 1));
  });

  it("resumes a paused retained runtime when attaching by handle", async () => {
    const server = mockSdkServer();
    server.state = "Paused";
    server.override = call => {
      if (call.method === "POST" && call.url.pathname === "/v1/sandboxes/sb-1/resume") { server.state = "Running"; return new Response(null, { status: 204 }); }
      return undefined;
    };
    const sandbox = await sandboxProvider.resume({ provider: "opensandbox", runtimeId: "sb-1" }, ctx, env);
    allocations.push(sandbox);
    expect(server.calls.some(call => call.url.pathname === "/v1/sandboxes/sb-1/resume")).toBe(true);
    expect(await sandbox.status()).toBe("running");
  });

  it("creates a filesystem snapshot, waits until ready, and restores from it", async () => {
    const server = mockSdkServer();
    const sandbox = await create({ OPENSANDBOX_SNAPSHOT_POLL_MS: "1" });
    let polls = 0;
    const snapshot = (state: string) => Response.json({ id: "snap-1", sandboxId: "sb-1", name: "ckpt", status: { state }, createdAt: "2026-10-26T08:00:00Z" });
    server.override = call => {
      if (call.method === "POST" && call.url.pathname === "/v1/sandboxes/sb-1/snapshots") return snapshot("Creating");
      if (call.method === "GET" && call.url.pathname === "/v1/snapshots/snap-1") return snapshot(++polls < 2 ? "Creating" : "Ready");
      return undefined;
    };
    const checkpoint = await sandbox.checkpoint({ kind: "filesystem", name: "ckpt" });
    expect(checkpoint).toEqual({ provider: "opensandbox", checkpointId: "snap-1", sourceRuntimeId: "sb-1", kind: "filesystem", scope: "portable" });
    expect(server.calls.find(call => call.url.pathname === "/v1/sandboxes/sb-1/snapshots")!.body).toEqual({ name: "ckpt" });
    expect(polls).toBe(2);
    server.calls.length = 0;
    const restored = await sandboxProvider.restore(checkpoint, ctx, env);
    allocations.push(restored);
    const creation = server.calls.find(call => call.method === "POST" && call.url.pathname === "/v1/sandboxes");
    expect(creation!.body).toMatchObject({ snapshotId: "snap-1" });
    expect(creation!.body).not.toHaveProperty("image");
  });

  it("reports failed and timed-out snapshots without SDK error details", async () => {
    const server = mockSdkServer();
    const sandbox = await create({ OPENSANDBOX_SNAPSHOT_POLL_MS: "1", OPENSANDBOX_SNAPSHOT_TIMEOUT_MS: "1" });
    const snapshot = (state: string) => Response.json({ id: "snap-1", sandboxId: "sb-1", status: { state, message: "provider-secret" }, createdAt: "2026-10-26T08:00:00Z" });
    server.override = call => call.url.pathname.endsWith("/snapshots") ? snapshot("Failed") : undefined;
    await expect(sandbox.checkpoint({ kind: "filesystem" })).rejects.toThrow(/^OpenSandbox snapshot failed$/);
    server.override = call => call.url.pathname.includes("snap") ? snapshot("Creating") : undefined;
    await expect(sandbox.checkpoint({ kind: "filesystem" })).rejects.toThrow("did not become ready");
    server.override = call => call.url.pathname.endsWith("/snapshots") ? new Response("provider-secret", { status: 501 }) : undefined;
    await expect(sandbox.checkpoint({ kind: "filesystem" })).rejects.toThrow(/^OpenSandbox snapshot failed \(HTTP 501\)$/);
    server.override = call => call.url.pathname.endsWith("/pause") ? new Response("provider-secret", { status: 409 }) : undefined;
    await expect(sandbox.suspend({ kind: "filesystem" })).rejects.toThrow(/^OpenSandbox request failed \(HTTP 409\)$/);
    server.calls.length = 0;
    server.override = call => call.url.pathname.endsWith("/renew-expiration") ? new Response("provider-secret", { status: 409 }) : undefined;
    await expect(sandbox.suspend({ kind: "filesystem" })).rejects.toThrow(/^OpenSandbox request failed \(HTTP 409\)$/);
    expect(server.calls.some(call => call.url.pathname.endsWith("/pause"))).toBe(false);
    expect(() => optionsFromEnvironment({ OPENSANDBOX_SUSPENDED_TTL_SECONDS: "59" })).toThrow(">= 60");
  });

  it("configures the SDK lifecycle API using only domain and protocol", async () => {
    const server = mockSdkServer();
    await create({ OPENSANDBOX_DOMAIN: "control.test:8443", OPENSANDBOX_PROTOCOL: "https" });
    expect(server.calls[0]!.url.href).toBe("https://control.test:8443/v1/sandboxes");
  });

  it("closes the SDK transport on idempotent destruction and leaves failed deletion retryable", async () => {
    const server = mockSdkServer();
    const close = vi.spyOn(SdkSandbox.prototype, "close");
    const sandbox = await create();
    let deletes = 0;
    server.override = call => call.method === "DELETE" && call.url.pathname.endsWith("/sb-1")
      ? new Response(null, { status: ++deletes === 1 ? 500 : 404 }) : undefined;
    await expect(sandbox.destroy()).rejects.toThrow("HTTP 500");
    expect(close).not.toHaveBeenCalled();
    await sandbox.destroy();
    await sandbox.destroy();
    expect(close).toHaveBeenCalledOnce();
    expect(deletes).toBe(2);
    expect(await sandbox.status()).toBe("stopped");
    await expect(sandbox.exec("true")).rejects.toThrow("destroyed");
  });

  it("does not disclose SDK error bodies or credentials", async () => {
    const server = mockSdkServer();
    server.override = () => new Response("provider-secret", { status: 401 });
    await expect(create()).rejects.toThrow(/^OpenSandbox create failed \(HTTP 401\)$/);
    server.override = undefined;
    const sandbox = await create();
    server.override = call => call.url.pathname.endsWith("/files/download") ? new Response("provider-secret", { status: 403 }) : undefined;
    await expect(sandbox.readFile("private")).rejects.toThrow(/^OpenSandbox request failed \(HTTP 403\)$/);
    server.override = () => new Response("provider-secret", { status: 401 });
    await expect(sandboxProvider.resume({ provider: "opensandbox", runtimeId: "sb-1" }, ctx, env)).rejects.toThrow(/^OpenSandbox resume failed \(HTTP 401\)$/);
  });

  it("maps missing and paused runtimes without exposing SDK errors", async () => {
    const server = mockSdkServer();
    const sandbox = await create();
    server.override = call => call.url.pathname.endsWith("/sb-1") ? new Response(null, { status: 404 }) : undefined;
    expect(await sandbox.status()).toBe("stopped");
    server.override = undefined;
    server.state = "Paused";
    expect(await sandbox.status()).toBe("suspended");
    server.state = "Failed";
    expect(await sandbox.status()).toBe("stopped");
    await expect(sandboxProvider.resume({ provider: "opensandbox", runtimeId: "sb-1" }, ctx, env)).rejects.toThrow("stopped");
  });

  it("cleans up a newly created allocation when SDK readiness fails", async () => {
    const server = mockSdkServer();
    server.override = call => call.url.pathname.endsWith("/ping") ? new Response(null, { status: 503 }) : undefined;
    await expect(create({ OPENSANDBOX_READY_TIMEOUT_MS: "20" })).rejects.toThrow("OpenSandbox create failed");
    expect(server.calls.some(call => call.method === "DELETE" && call.url.pathname.endsWith("/sb-1"))).toBe(true);
  });

  it("cleans up an allocation if workspace preparation fails", async () => {
    const server = mockSdkServer();
    server.override = call => call.url.pathname.endsWith("/directories") ? new Response(null, { status: 500 }) : undefined;
    await expect(create()).rejects.toThrow("HTTP 500");
    expect(server.calls.some(call => call.method === "DELETE" && call.url.pathname.endsWith("/sb-1"))).toBe(true);
  });

  it("validates endpoint schemes and lease durations", async () => {
    mockSdkServer();
    const endpoint = vi.spyOn(SdkSandbox.prototype, "getEndpoint").mockResolvedValue({ endpoint: "file:///etc/passwd" });
    const sandbox = await create();
    await expect(sandbox.serviceEndpoint(1234)).rejects.toThrow("invalid service endpoint");
    expect(endpoint).toHaveBeenCalled();
    await expect(sandbox.renewLease({ ttlMs: 0 })).rejects.toThrow("positive integer");
  });

  it("uses existing connection variables and validates configured time units", () => {
    expect(optionsFromEnvironment({})).toMatchObject({ domain: "localhost:8080", protocol: "http", timeoutSeconds: 1800 });
    expect(optionsFromEnvironment({ OPENSANDBOX_DOMAIN: "api.test:8443", OPEN_SANDBOX_API_KEY: "sdk-alias", SANDBOX_IMAGE: "custom", OPENSANDBOX_TIMEOUT_SECONDS: "60" })).toMatchObject({ domain: "api.test:8443", apiKey: "sdk-alias", image: "custom", timeoutSeconds: 60 });
    expect(optionsFromEnvironment({ OPENSANDBOX_PROTOCOL: "https", OPENSANDBOX_DOMAIN: "host" })).toMatchObject({ domain: "host", protocol: "https" });
    for (const value of ["-1", "0", "59", "1.5", "bad"]) expect(() => optionsFromEnvironment({ OPENSANDBOX_TIMEOUT_SECONDS: value })).toThrow("OPENSANDBOX_TIMEOUT_SECONDS");
    expect(() => optionsFromEnvironment({ OPENSANDBOX_PROTOCOL: "file" })).toThrow("OPENSANDBOX_PROTOCOL");
    for (const domain of ["", "https://host/v1", "user:pass@host", "host/v1", "host?key=value", "host#fragment"]) {
      expect(() => optionsFromEnvironment({ OPENSANDBOX_DOMAIN: domain })).toThrow("OPENSANDBOX_DOMAIN");
    }
  });
});
