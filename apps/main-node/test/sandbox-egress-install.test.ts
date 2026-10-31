import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareSandboxEgress, clearSandboxEgress } from "../../../packages/sandbox-egress/src/install";
import { sandboxProvider } from "../../../packages/sandbox-adapter-opensandbox/src/index";
import { mockSdkServer } from "../../../packages/sandbox-adapter-opensandbox/test/sdk-http";
import { SpritesRuntime } from "../../../packages/managed-runtime-sprites/src/sprites";
import type { SandboxPort } from "@open-managed-agents/sandbox";
import { LocalSubprocessSandbox } from "../../../packages/sandbox/src/adapters/local-subprocess";
import { DefaultNodeManagedSessionRunner } from "../../../packages/control-plane-node/src/lib/node-managed-session-runner";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
const scope = { workspaceId: "workspace", sessionId: "session", vaultIds: ["vault"] };
const input = (sandbox: SandboxPort) => ({ sandbox, scope, relay: { endpoint: "https://control.example", pass: "" }, issuePass: async () => "session-pass", placeholders: async () => ({ GITHUB_TOKEN: "__cap_managed__" }) });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("sandbox credential egress installation boundary", () => {
  it.each(["stop", "refresh failure", "cold refresh failure"])("terminates a real local health relay on %s after refresh revocation", async (reason) => {
    const root = await mkdtemp(resolve(".egress-lifecycle-"));
    const raw = new LocalSubprocessSandbox({ workdir: root });
    const write = raw.writeFile.bind(raw);
    raw.writeFile = (path, content) => write(path, path.endsWith("/relay.cjs")
      ? `const fs=require('fs'),http=require('http'),path=require('path');const dir=process.argv[2];const s=http.createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>fs.writeFileSync(path.join(dir,'ready.json'),JSON.stringify({pid:process.pid,port:s.address().port,caFile:path.join(dir,'ca.crt'),caBundleFile:path.join(dir,'ca-bundle.crt')})));process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`
      : content);
    let pid = 0; let fail = false;
    const runner = new DefaultNodeManagedSessionRunner({
      buildSandbox: async () => raw, probeSandbox: async () => "alive",
      refreshSandboxEnvironment: async ({ sandbox, registerCleanup }) => {
        if (fail) throw new Error("refresh failed");
        const ready = await prepareSandboxEgress({ ...input(sandbox), registerCleanup });
        pid = ready.pid!;
        if (reason === "cold refresh failure") throw new Error("cold refresh failed");
      },
      outcomes: {} as never, confirmedTools: {} as never, buildModel: async () => ({} as never), buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {} }), buildHarnessContext: async () => ({} as never),
      clock: { now: () => new Date() }, ids: { nextEventId: () => "event_egress" },
    });
    const start = { workspaceId: "workspace", sessionId: "session", session: { id: "session", agent: { skills: [] }, resources: [] } as never,
      environment: { id: "env", config: {} } as never, initialEvents: [] };
    try {
      if (reason === "cold refresh failure") await expect(runner.start(start)).rejects.toThrow("cold refresh failed");
      else {
        await runner.start(start); process.kill(pid, 0);
        if (reason === "stop") await runner.stop(start);
        else { fail = true; await expect(runner.start(start)).rejects.toThrow("refresh failed"); }
      }
      await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow(); });
    } finally {
      if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} }
      await raw.destroy(); await rm(root, { recursive: true, force: true });
    }
  });

  it("uses native outbound capability without installing a Node process or local CA", async () => {
    const env: Record<string, string> = {};
    const native = { exec: vi.fn(async () => ""), readFile: async () => "", writeFile: vi.fn(async path => path), setEnvVars: async values => { Object.assign(env, values); }, prepareCredentialEgress: vi.fn(async () => {}), clearCredentialEgress: vi.fn(async () => {}) };
    await prepareSandboxEgress(input(native));
    expect(native.prepareCredentialEgress).toHaveBeenCalledWith({ endpoint: "https://control.example", pass: "session-pass" });
    expect(native.writeFile).not.toHaveBeenCalled(); expect(native.exec).not.toHaveBeenCalled();
    expect(env).toEqual({ GITHUB_TOKEN: "__cap_managed__" });
    await clearSandboxEgress(native);
    expect(native.clearCredentialEgress).toHaveBeenCalledOnce(); expect(env.GITHUB_TOKEN).toBe("");
    expect(native.exec).not.toHaveBeenCalled();
  });

  it.each(["node missing", "health check failed"])("fails explicitly instead of installing proxy env when %s", async reason => {
    const setEnvVars = vi.fn();
    const sandbox: SandboxPort = { exec: async command => command.includes("EGRESS_DIR:") ? "EGRESS_DIR:/workspace/.oma-egress" : reason, readFile: async () => "", writeFile: async path => path, setEnvVars };
    await expect(prepareSandboxEgress(input(sandbox))).rejects.toThrow(/installation\/readiness failed/);
    expect(setEnvVars).not.toHaveBeenCalled();
  });

  it("installs via the real OpenSandbox SDK command/file boundary and clears on removal", async () => {
    const server = mockSdkServer();
    // The SDK expects SSE command events even for installation probes.
    server.override = call => {
      if (!call.url.pathname.endsWith("/command")) return;
      const command = (call.body as { command: string }).command;
      const text = command.includes("EGRESS_DIR:") ? "EGRESS_DIR:/workspace/.oma-egress" : command.includes("EGRESS_READY:") ? 'EGRESS_READY:{"pid":42,"port":32123,"caFile":"/workspace/.oma-egress/ca.crt","caBundleFile":"/workspace/.oma-egress/ca-bundle.crt"}' : "";
      return new Response(`data: ${JSON.stringify({ type: "stdout", text })}\n\ndata: {"type":"execution_complete","execution_time":1}\n\n`, { headers: { "content-type": "text/event-stream" } });
    };
    const sandbox = await sandboxProvider.create({ sessionId: "session", workdir: "/workspace" }, { OPENSANDBOX_DOMAIN: "control.test:8080", OPENSANDBOX_API_KEY: "provider-key" });
    await prepareSandboxEgress(input(sandbox));
    await sandbox.exec("gh api user");
    const command = server.calls.filter(call => call.url.pathname === "/command").at(-1)!.body as { envs: Record<string, string> };
    expect(command.envs).toMatchObject({ GITHUB_TOKEN: "__cap_managed__", HTTPS_PROXY: "http://127.0.0.1:32123", NODE_EXTRA_CA_CERTS: "/workspace/.oma-egress/ca.crt" });
    const uploads = server.calls.filter(call => call.url.pathname.endsWith("/files/upload"));
    expect(uploads.length).toBeGreaterThanOrEqual(2);
    for (const call of uploads) expect(await ((call.body as FormData).get("file") as Blob).text()).not.toContain("real-token");
    await clearSandboxEgress(sandbox);
    await sandbox.exec("gh api user");
    const cleared = server.calls.filter(call => call.url.pathname === "/command").at(-1)!.body as { envs: Record<string,string> };
    expect(cleared.envs.HTTPS_PROXY).toBe(""); expect(cleared.envs.GITHUB_TOKEN).toBe("");
    await sandbox.destroy();
  });

  it("uses Sprites exec/files APIs without requiring provider startProcess support", async () => {
    const writes: string[] = []; const commands: Array<{ command: string; env: Record<string,string> }> = [];
    const sprite = {
      name: "test", labels: [], filesystem: () => ({ writeFile: async (path: string) => { writes.push(path); }, readFile: async () => "", mkdir: async () => {} }),
      execFileHTTP: async (_file: string, args: string[], options: { env?: Record<string,string> }) => {
        const command = args.at(-1)!; commands.push({ command, env: options.env ?? {} });
        return { stdout: command.includes("EGRESS_DIR:") ? "EGRESS_DIR:/workspace/.oma-egress" : command.includes("EGRESS_READY:") ? 'EGRESS_READY:{"pid":43,"port":32124,"caFile":"/workspace/.oma-egress/ca.crt","caBundleFile":"/workspace/.oma-egress/ca-bundle.crt"}' : "", stderr: "", exitCode: 0 };
      }, delete: async () => {}, closeControlConnection() {},
    };
    const sandbox = new SpritesRuntime({ client: {} as never, sprite: sprite as never });
    await prepareSandboxEgress(input(sandbox)); await sandbox.exec("gh api user");
    expect(writes).toEqual(expect.arrayContaining(["/workspace/.oma-egress/relay.cjs", "/workspace/.oma-egress/binding.next.json"]));
    expect(commands.at(-1)!.env).toMatchObject({ HTTPS_PROXY: "http://127.0.0.1:32124", GITHUB_TOKEN: "__cap_managed__" });
  });
});
