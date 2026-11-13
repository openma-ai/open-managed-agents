import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { E2BSandboxExecutor } from "../src/e2b";
import type { SandboxManagedProcessSpec } from "@open-managed-agents/sandbox";

// CI must execute native process/identity tests, not silently count skips.
beforeAll(() => {
  if (process.env.OMA_REQUIRE_NATIVE_BOOTSTRAP === "1" &&
      (process.platform !== "linux" || process.getuid?.() !== 0)) {
    throw new Error("Native bootstrap gate requires Linux uid 0 in an isolated user namespace");
  }
});

const roots: string[] = [];
const daemons: ChildProcess[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) { if (daemon.exitCode !== null) continue; const done = new Promise<void>(r => daemon.once("exit", () => r())); daemon.kill("SIGTERM"); await done; }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function eventually(check: () => Promise<void>) {
  for (let n = 0; ; n++) { try { await check(); return; } catch (e) { if (n === 100) throw e; await new Promise(r => setTimeout(r, 20)); } }
}
async function fixture() {
  const root = await mkdtemp(join(process.cwd(), "test/.bootstrap-")); roots.push(root);
  const hook = join(root, "hook.sh"); const marker = join(root, "hook-executed");
  await writeFile(hook, 'printf unsafe > "' + marker + '"');
  const daemon = spawn("/usr/bin/python3", ["-I", "-S", new URL("../template/launcher.py", import.meta.url).pathname, root], {
    env: { ...process.env, BASH_ENV: hook, ENV: hook, NODE_OPTIONS: "--require=/nonexistent/poison.cjs", IMAGE_SECRET: "not-for-worker" }, stdio: "ignore",
  }); daemons.push(daemon);
  await eventually(async () => { await access(join(root, "ready")); });
  let shellCalls = 0;
  const sandbox = {
    sandboxId: "owned-test", commands: { run: async () => { shellCalls++; throw Error("shell forbidden"); } },
    files: { read: (p: string) => readFile(p, "utf8"), write: (p: string, data: string | Uint8Array) => writeFile(p, data) },
    kill: async () => { daemon.kill("SIGTERM"); },
  };
  const adapter = new E2BSandboxExecutor(sandbox, { managedBootstrap: { directory: root } });
  await adapter.setEnvVars({ SESSION_SECRET: "not-for-worker", NODE_OPTIONS: "--require=/also-poison.cjs" });
  return { root, marker, adapter, shellCalls: () => shellCalls };
}

// Native identity/process-group semantics require Linux waitid/WNOWAIT.
// Run test/managed-bootstrap-linux.py in a disposable Linux root container on macOS.
describe("template-native management bootstrap", () => {
  it("exposes safe managed launch rather than shell startProcess", () => {
    expect(typeof new E2BSandboxExecutor({} as never, {}).startManagedProcess).toBe("function");
  });
  it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("replaces poisoned image/session env before executable startup and preserves argv/cwd", async () => {
    const { root, marker, adapter, shellCalls } = await fixture();
    const output = join(root, "observed.json");
    const args = ["quote'", "$(touch forbidden)", "space and\nnewline", "--flag"];
    const handle = await adapter.startManagedProcess({ command: process.execPath, args: ["-e", "require('fs').writeFileSync(process.argv[1],JSON.stringify({env:process.env,args:process.argv.slice(2),cwd:process.cwd()}))", output, ...args], cwd: root, env: { ONLY: "yes" } });
    await eventually(async () => { expect(await handle.getStatus()).toBe("exited"); });
    const observed = JSON.parse(await readFile(output, "utf8"));
    // macOS injects this platform variable in native executables independently.
    delete observed.env.__CF_USER_TEXT_ENCODING;
    expect(observed).toEqual({ env: { ONLY: "yes" }, args, cwd: root });
    await expect(access(marker)).rejects.toThrow();
    expect(shellCalls()).toBe(0);
  });
  it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("reports native spawn failure and manages status / signal without shell", async () => {
    const { adapter, shellCalls } = await fixture();
    await expect(adapter.startManagedProcess({ command: "/nonexistent/worker", env: {} })).rejects.toThrow(/spawn/i);
    const handle = await adapter.startManagedProcess({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: "/", env: {} });
    expect(await handle.getStatus()).toBe("running");
    await expect(handle.kill("bad-signal")).rejects.toThrow(/signal/i);
    await handle.kill("SIGKILL");
    await eventually(async () => { expect(await handle.getStatus()).toBe("exited"); });
    await handle.kill("SIGTERM");
    expect(shellCalls()).toBe(0);
  });
  it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("rejects root agent execution and malformed native launch inputs", async () => {
    expect(() => new E2BSandboxExecutor({} as never, { managedBootstrap: {}, user: "root" })).toThrow(/unprivileged/i);
    const { adapter, shellCalls } = await fixture();
    for (const spec of [{ command: "node", env: {} }, { command: process.execPath, args: ["bad\u0000arg"], env: {} }, { command: process.execPath, env: { "BAD=NAME": "x" } }] as SandboxManagedProcessSpec[]) {
      await expect(adapter.startManagedProcess(spec)).rejects.toThrow();
    }
    expect(shellCalls()).toBe(0);
  });
  it("never retries or shell-falls-back after an ambiguous file dispatch", async () => {
    let writes = 0;
    const adapter = new E2BSandboxExecutor({ files: { read: async () => "oma-managed-v2", write: async () => { writes++; throw Error("transport lost"); } } } as never, { managedBootstrap: {} });
    await expect(adapter.startManagedProcess({ command: process.execPath, env: {} })).rejects.toThrow(/outcome unknown/i);
    await expect(adapter.startManagedProcess({ command: process.execPath, env: {} })).rejects.toThrow(/closed/i);
    expect(writes).toBe(1);
  });
  it("waits for in-flight launch before sandbox destruction and surfaces destroy failure", async () => {
    let release!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    const events: string[] = [];
    const adapter = new E2BSandboxExecutor({ files: { read: async () => { await pending; events.push("ready"); throw Error("gone"); } }, kill: async () => { events.push("kill"); throw Error("destroy denied"); } } as never, { managedBootstrap: {} });
    const starting = adapter.startManagedProcess({ command: process.execPath, env: {} });
    const destroying = adapter.destroy();
    expect(events).toEqual([]);
    release();
    await expect(starting).rejects.toThrow("gone");
    await expect(destroying).rejects.toThrow("destroy denied");
    expect(events).toEqual(["ready", "kill"]);
  });
  it.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("fails closed without a preinstalled bootstrap and after destroy", async () => {
    const { adapter } = await fixture();
    await adapter.destroy();
    await expect(adapter.startManagedProcess({ command: process.execPath, env: {} })).rejects.toThrow(/clos/i);
    const plain = new E2BSandboxExecutor({ commands: { run: async () => { throw Error("must not call shell"); } } } as never, {});
    await expect(plain.startManagedProcess({ command: process.execPath, env: {} })).rejects.toThrow(/template/i);
  });
});
