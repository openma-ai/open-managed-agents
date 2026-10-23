import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenSandbox, optionsFromEnvironment, sandboxFactory, sandboxProvider } from "../src/index";

const ctx = { sessionId: "session-test", workdir: "/workspace" };
const env = { OPENSANDBOX_DOMAIN: "control.test:8080", OPENSANDBOX_API_KEY: "provider-secret" };
const info = (state = "Running") => ({ id: "sb-1", status: { state } });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const sse = (events: unknown[], fragmented = false) => {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new Response(fragmented ? new ReadableStream({
    start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); },
  }) : text, { headers: { "Content-Type": "text/event-stream" } });
};
const done = { type: "execution_complete", exit_code: 0 };
function mockServer(commandEvents: unknown[] = [done]) {
  return vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === "http://control.test:8080/v1/sandboxes" && init.method === "POST") return response(info());
    if (url.endsWith("/endpoints/44772")) return response({ endpoint: "exec.test:44772", headers: { "X-EXECD-ACCESS-TOKEN": "runtime-token" } });
    if (url === "http://exec.test:44772/command") return sse(commandEvents, true);
    if (url.startsWith("http://exec.test:44772/files/download")) return new Response(Uint8Array.of(0, 255, 1));
    if (url.endsWith("/sb-1") && !init.method) return response(info());
    return response({});
  }));
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("OpenSandbox native HTTP adapter", () => {
  it("creates, executes, transfers binary files and destroys through the provider port", async () => {
    mockServer([{ type: "stdout", text: "hello\n" }, { type: "stderr", text: "warning\n" }, done]);
    const sandbox = await sandboxFactory(ctx, env) as OpenSandbox;
    expect(sandbox.runtimeHandle()).toEqual({ provider: "opensandbox", runtimeId: "sb-1" });
    expect(sandbox.runtimeCapabilities()).toEqual({ lease: true, suspend: [], checkpoint: [] });
    await sandbox.setEnvVars({ COMMON: "yes" });
    sandbox.registerCommandSecrets("git", { TOKEN: "scoped-secret" });
    expect(await sandbox.exec("git status", 1234)).toBe("hello\nwarning");
    expect(await sandbox.writeFile("nested/hello.txt", "héllo")).toBe("/workspace/nested/hello.txt");
    expect(await sandbox.writeFileBytes("/workspace/raw.bin", Uint8Array.of(0, 255, 1))).toBe("/workspace/raw.bin");
    expect(await sandbox.readFileBytes("raw.bin")).toEqual(Uint8Array.of(0, 255, 1));
    expect(await sandbox.readFile("raw.bin")).toBe("\0�\x01");
    await sandbox.renewLease({ ttlMs: 60_000 });
    await sandbox.destroy();
    await sandbox.destroy();
    expect(await sandbox.status()).toBe("stopped");
    await expect(sandbox.exec("true")).rejects.toThrow("destroyed");
    const calls = vi.mocked(fetch).mock.calls;
    const creation = calls.find(([url]) => url === "http://control.test:8080/v1/sandboxes")![1]!;
    expect(JSON.parse(creation.body as string)).toEqual({
      image: { uri: "node:22-slim" }, timeout: 1800, resourceLimits: { cpu: "1", memory: "1Gi" },
      entrypoint: ["tail", "-f", "/dev/null"], metadata: { "oma-session-id": "session-test" },
    });
    expect(creation.headers).toHaveProperty("OPEN-SANDBOX-API-KEY", "provider-secret");
    const command = calls.find(([url]) => String(url).endsWith("/command"))![1]!;
    expect(JSON.parse(command.body as string)).toEqual({ command: "git status", timeout: 1234, background: false, cwd: "/workspace", envs: { COMMON: "yes", TOKEN: "scoped-secret" } });
    for (const [url, init] of calls.filter(([url]) => String(url).startsWith("http://exec.test"))) {
      expect(init!.headers).not.toHaveProperty("OPEN-SANDBOX-API-KEY");
      expect(init!.headers).toHaveProperty("X-EXECD-ACCESS-TOKEN", "runtime-token");
      expect(String(init!.body)).not.toContain("provider-secret");
    }
    const upload = calls.filter(([url]) => String(url).endsWith("/files/upload")).at(-1)![1]!.body as FormData;
    expect(JSON.parse(upload.get("metadata") as string)).toEqual({ path: "/workspace/raw.bin", mode: 644 });
    expect(new Uint8Array(await (upload.get("file") as Blob).arrayBuffer())).toEqual(Uint8Array.of(0, 255, 1));
    expect(calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("reattaches a live runtime and refuses unsupported lifecycle operations", async () => {
    mockServer();
    const sandbox = await sandboxProvider.resume({ provider: "opensandbox", runtimeId: "sb-1" }, ctx, env);
    expect(await sandbox.status()).toBe("running");
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => String(init?.body).includes('"image"'))).toBe(false);
    await expect(sandbox.suspend()).rejects.toThrow("not supported");
    await expect(sandbox.checkpoint()).rejects.toThrow("not supported");
    await expect(sandbox.resume()).rejects.toThrow("not supported");
    await expect(sandboxProvider.resume({ provider: "e2b", runtimeId: "x" }, ctx, env)).rejects.toThrow("Incompatible");
    await expect(sandboxProvider.restore({ provider: "opensandbox", checkpointId: "x", sourceRuntimeId: "x", scope: "portable", kind: "filesystem" }, ctx, env)).rejects.toThrow("not supported");
  });

  it.each([
    [[{ type: "error", error: { exit_code: 3, evalue: "3" } }, done], "\n[exit 3]"],
    [[{ type: "error", error: { evalue: "2" } }, done], "\n[exit 2]"],
  ])("reports nonzero command exits", async (events, expected) => {
    mockServer(events);
    expect(await (await sandboxProvider.create(ctx, env)).exec("false")).toBe(expected);
  });

  it("rejects command startup failures and truncated streams", async () => {
    mockServer([{ type: "error", error: { evalue: "cannot start" } }, done]);
    const sandbox = await sandboxProvider.create(ctx, env);
    await expect(sandbox.exec("missing")).rejects.toThrow("failed to execute");
    mockServer([{ type: "stdout", text: "partial" }]);
    await expect(sandbox.exec("true")).rejects.toThrow("before execution_complete");
  });

  it("cleans up an allocation whose provisioning fails", async () => {
    mockServer();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => String(url).endsWith("/sb-1") && !init?.method ? response(info("Failed")) : original(url, init));
    await expect(sandboxProvider.create(ctx, env)).rejects.toThrow("stopped during provisioning");
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("waits for lifecycle Running before touching execd", async () => {
    mockServer();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let count = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) => String(url).endsWith("/sb-1") && !init?.method && count++ === 0 ? response(info("Pending")) : original(url, init));
    await sandboxProvider.create(ctx, env);
    expect(count).toBe(2);
  });

  it("does not disclose response bodies or credentials in HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret-key", { status: 401 })));
    await expect(sandboxProvider.create(ctx, env)).rejects.toThrow("OpenSandbox create failed (HTTP 401)");
    const sandbox = new OpenSandbox("sb-1", optionsFromEnvironment(env));
    await expect(sandbox.readFile("x")).rejects.toThrow("OpenSandbox request failed (HTTP 401)");
  });

  it("retries a failed delete and treats an already deleted runtime as destroyed", async () => {
    const sandbox = new OpenSandbox("sb-1", optionsFromEnvironment(env));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 500 })).mockResolvedValueOnce(new Response(null, { status: 404 })));
    await expect(sandbox.destroy()).rejects.toThrow("HTTP 500");
    await sandbox.destroy();
    expect(await sandbox.status()).toBe("stopped");
  });

  it("reports a missing runtime as stopped and rejects attaching a paused one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    const sandbox = new OpenSandbox("sb-1", optionsFromEnvironment(env));
    expect(await sandbox.status()).toBe("stopped");
    vi.mocked(fetch).mockResolvedValue(response(info("Paused")));
    await expect(sandboxProvider.resume({ provider: "opensandbox", runtimeId: "sb-1" }, ctx, env)).rejects.toThrow("paused");
  });

  it("retries execd readiness without leaking the provider key", async () => {
    mockServer();
    const original = vi.mocked(fetch).getMockImplementation()!;
    let pings = 0;
    vi.mocked(fetch).mockImplementation(async (url, init) => String(url).endsWith("/ping") && pings++ === 0 ? new Response(null, { status: 503 }) : original(url, init));
    await sandboxProvider.create(ctx, env);
    expect(pings).toBe(2);
  });

  it("bounds provisioning waits and deletes a timed-out allocation", async () => {
    mockServer();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => String(url).endsWith("/sb-1") && !init?.method ? response(info("Pending")) : original(url, init));
    await expect(sandboxProvider.create(ctx, { ...env, OPENSANDBOX_READY_TIMEOUT_MS: "20" })).rejects.toThrow();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("rejects invalid service endpoints and invalid lease durations", async () => {
    const sandbox = new OpenSandbox("sb-1", optionsFromEnvironment(env));
    vi.stubGlobal("fetch", vi.fn(async () => response({ endpoint: "file:///etc/passwd" })));
    await expect(sandbox.readFile("x")).rejects.toThrow("invalid service endpoint");
    await expect(sandbox.renewLease({ ttlMs: 0 })).rejects.toThrow("positive integer");
  });

  it("uses Harbor connection names, explicit API base URLs, and validates time units", () => {
    expect(optionsFromEnvironment({})).toMatchObject({ baseUrl: "http://localhost:8080/v1", timeoutSeconds: 1800 });
    expect(optionsFromEnvironment({ OPENSANDBOX_BASE_URL: "https://api.test/prefix/v1/", OPEN_SANDBOX_API_KEY: "sdk-alias", SANDBOX_IMAGE: "custom", OPENSANDBOX_TIMEOUT_SECONDS: "60" })).toMatchObject({ baseUrl: "https://api.test/prefix/v1", apiKey: "sdk-alias", image: "custom", timeoutSeconds: 60 });
    expect(optionsFromEnvironment({ OPENSANDBOX_PROTOCOL: "https", OPENSANDBOX_DOMAIN: "host" }).baseUrl).toBe("https://host/v1");
    for (const value of ["-1", "0", "59", "1.5", "bad"]) expect(() => optionsFromEnvironment({ OPENSANDBOX_TIMEOUT_SECONDS: value })).toThrow("OPENSANDBOX_TIMEOUT_SECONDS");
    expect(() => optionsFromEnvironment({ OPENSANDBOX_BASE_URL: "file:///tmp/key" })).toThrow("HTTP(S)");
    expect(() => optionsFromEnvironment({ OPENSANDBOX_BASE_URL: "http://user:pass@host/v1" })).toThrow("credentials");
  });
});
