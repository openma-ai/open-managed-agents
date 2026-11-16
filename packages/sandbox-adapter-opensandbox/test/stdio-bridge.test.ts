import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import type { Sandbox as SdkSandbox } from "@alibaba-group/opensandbox";
import { OpenSandbox, optionsFromEnvironment } from "../src/index";

let relay: ChildProcess | undefined;
afterEach(() => {
  if (relay?.pid) { try { process.kill(-relay.pid, "SIGKILL"); } catch { /* exited */ } }
  relay = undefined;
  vi.restoreAllMocks();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function fixture() {
  const port = await freePort();
  const written: Array<{ path: string; mode: number | undefined; text: string }> = [];
  const dirs: Array<{ path: string; mode?: number }> = [];
  const deleted: string[] = [];
  // Local-filesystem stand-in for the SDK files API (paths are /tmp/openma-stdio-*).
  const files = {
    createDirectories: async (entries: Array<{ path: string; mode?: number }>) => {
      for (const e of entries) { dirs.push(e); mkdirSync(e.path, { recursive: true, mode: e.mode ? parseInt(String(e.mode), 8) : undefined }); }
    },
    writeFiles: async (entries: Array<{ path: string; data: Uint8Array; mode?: number }>) => {
      for (const e of entries) {
        let text = Buffer.from(e.data).toString("utf8");
        written.push({ path: e.path, mode: e.mode, text });
        // Redirect only the exposed service port so this test needs no OpenSandbox server.
        if (e.path.endsWith("/spec.json")) text = JSON.stringify({ ...JSON.parse(text), port });
        writeFileSync(e.path, text, { mode: e.mode ? parseInt(String(e.mode), 8) : undefined });
      }
    },
    deleteDirectories: async (paths: string[]) => { for (const p of paths) { deleted.push(p); rmSync(p, { recursive: true, force: true }); } },
  };
  const sandbox = new OpenSandbox({ id: "sb-1", files } as unknown as SdkSandbox, optionsFromEnvironment({}));
  const run = vi.spyOn(sandbox, "run").mockImplementation(async (command) => {
    // Run the exact relay command produced by the adapter.
    relay = spawn(command, { shell: true, detached: true, stdio: "ignore" });
    return { logs: { stdout: [], stderr: [] }, result: [], complete: { timestamp: Date.now(), executionTimeMs: 0 } };
  });
  vi.spyOn(sandbox, "serviceEndpoint").mockResolvedValue({ endpoint: `http://127.0.0.1:${port}`, headers: undefined });
  return { sandbox, port, run, written, dirs, deleted };
}

it("keeps registered secrets and the relay token off the command line while the child still gets them", async () => {
  const { sandbox, run, written, dirs } = await fixture();
  await sandbox.setEnvVars({ COMMON: "inherited" });
  sandbox.registerCommandSecrets(process.execPath, { VAULT_SECRET: "s3cr3t-vault-value" });
  const child = await sandbox.spawnDuplexProcess({
    command: process.execPath, cwd: process.cwd(), env: { EXTRA: "per-call" },
    args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write([process.env.VAULT_SECRET, process.env.COMMON, process.env.EXTRA].join(',')))"],
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  await child.stdin.getWriter().close();
  await stderr;
  expect(await child.exited).toEqual({ code: 0, signal: null });
  expect(await stdout).toBe("s3cr3t-vault-value,inherited,per-call");

  const specFile = written.find((f) => f.path.endsWith("/spec.json"))!;
  const { token } = JSON.parse(specFile.text) as { token: string };
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  const command = run.mock.calls[0]![0];
  expect(command).not.toContain("s3cr3t-vault-value");
  expect(command).not.toContain(token);
  expect(command).toMatch(/^node '\/tmp\/openma-stdio-[0-9a-f]+\/relay\.js' '\/tmp\/openma-stdio-[0-9a-f]+\/spec\.json'$/);
  expect(written.find((f) => f.path.endsWith("/relay.js"))!.text).not.toContain("s3cr3t-vault-value");
  expect(written.every((f) => f.mode === 600)).toBe(true);
  expect(dirs).toEqual([{ path: specFile.path.replace(/\/spec\.json$/, ""), mode: 700 }]);
  // The relay removes its spec (and private dir) before the child runs.
  expect(existsSync(specFile.path)).toBe(false);
});

it("removes the private relay files when the relay fails to start", async () => {
  const { sandbox, run, written, deleted } = await fixture();
  run.mockResolvedValueOnce({ logs: { stdout: [], stderr: [] }, result: [], error: { name: "x", value: "y", timestamp: 0, traceback: [] } });
  await expect(sandbox.spawnDuplexProcess({ command: process.execPath, args: ["-e", ""] })).rejects.toThrow("failed to start");
  const dir = written[0]!.path.replace(/\/[^/]+$/, "");
  expect(deleted).toEqual([dir]);
  expect(existsSync(dir)).toBe(false);
});

it("preserves binary stdin/stdout/stderr and real exit codes without a PTY", async () => {
  const { sandbox, port, run } = await fixture();
  await sandbox.setEnvVars({ COMMON: "inherited" });
  const child = await sandbox.spawnDuplexProcess({
    command: process.execPath,
    cwd: process.cwd(),
    args: ["-e", "if(process.env.COMMON !== 'inherited') process.exit(99); process.stdin.on('data', b => { process.stdout.write(b); process.stderr.write(b); }); process.stdin.on('end', () => process.exitCode = 7)"],
  });
  expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(401);
  expect(run).toHaveBeenCalledWith(expect.any(String), 120_000, true);
  const stdout = new Response(child.stdout).arrayBuffer();
  const stderr = new Response(child.stderr).arrayBuffer();
  const writer = child.stdin.getWriter();
  await writer.write(Uint8Array.of(0, 255, 10, 13, 65));
  await writer.write(Uint8Array.of(66, 128));
  await writer.close();
  expect(new Uint8Array(await stdout)).toEqual(Uint8Array.of(0, 255, 10, 13, 65, 66, 128));
  expect(new Uint8Array(await stderr)).toEqual(Uint8Array.of(0, 255, 10, 13, 65, 66, 128));
  expect(await child.exited).toEqual({ code: 7, signal: null });
  await expect(writer.write(Uint8Array.of(1))).rejects.toThrow();
});

it("terminates a sandbox child with the requested signal", async () => {
  const { sandbox } = await fixture();
  const child = await sandbox.spawnDuplexProcess({ command: process.execPath, cwd: process.cwd(), args: ["-e", "setInterval(() => {}, 1000)"] });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  await child.kill("SIGKILL");
  expect(await child.exited).toEqual({ code: null, signal: "SIGKILL" });
  await Promise.all([stdout, stderr]);
});


it("recovers exit observation after a disconnected request without treating it as process exit", async () => {
  const { sandbox } = await fixture();
  const realFetch = globalThis.fetch;
  let interrupted = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/exit") && !interrupted) {
      interrupted = true;
      // Lose the actual HTTP observation, not the sandbox process.
      await realFetch(url, { ...init, signal: AbortSignal.abort(new Error("exit connection lost")) });
    }
    return realFetch(url, init);
  });
  const child = await sandbox.spawnDuplexProcess({ command: process.execPath, cwd: process.cwd(), args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(7))"] });
  const streams = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  let settled = false;
  void child.exited.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 400));
  const settledBeforeExit = settled;
  await child.stdin.getWriter().close();
  const outcome = await child.exited.catch(error => error);
  await streams;
  expect(settledBeforeExit).toBe(false);
  expect(outcome).toEqual({ code: 7, signal: null });
});

it("keeps silent raw stdio usable beyond fetch idle deadlines without injecting heartbeat bytes", async () => {
  const { sandbox } = await fixture();
  const original = getGlobalDispatcher();
  // Accelerate real Undici deadlines, respecting an explicit no-idle-timeout
  // policy. fetch supplies 300s itself; request can explicitly opt out.
  const dispatcher = new Agent();
  const dispatch = dispatcher.dispatch.bind(dispatcher);
  dispatcher.dispatch = (options, handler) => dispatch({
    ...options, headersTimeout: 100,
    bodyTimeout: options.bodyTimeout === 0 ? 0 : 100,
  }, handler);
  setGlobalDispatcher(dispatcher);
  try {
    const child = await sandbox.spawnDuplexProcess({ command: process.execPath, cwd: process.cwd(), args: ["-e", "process.stdin.on('data', b => { process.stdout.write(b); process.stderr.write(b); });"] });
    const stdout = new Response(child.stdout).text().catch(error => error);
    const stderr = new Response(child.stderr).text().catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 1_600));
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode("after idle"));
    await writer.close();
    const outcome = await child.exited.catch(error => error);
    expect(await stdout).toBe("after idle");
    expect(await stderr).toBe("after idle");
    expect(outcome).toEqual({ code: 0, signal: null });
  } finally {
    setGlobalDispatcher(original);
    await dispatcher.destroy();
  }
});

it("rejects lost exit observation with its cause instead of inventing a successful exit", async () => {
  const { sandbox } = await fixture();
  const realFetch = globalThis.fetch;
  const cause = new Error("relay unavailable");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/exit")) throw cause;
    return realFetch(url, init);
  });
  const child = await sandbox.spawnDuplexProcess({ command: process.execPath, cwd: process.cwd(), args: ["-e", "process.stdin.resume()"] });
  const streams = Promise.allSettled([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    const error = await child.exited.catch(error => error);
    expect(error).toMatchObject({ cause });
    expect(error.message).toContain("phase=exit_observation");
    expect(error.message).toContain("sandbox=sb-1");
    expect(error.message).toContain("unconfirmed");
  } finally {
    await child.kill("SIGKILL");
    await streams;
  }
});

it("does not accept malformed exit receipts as proof of process exit", async () => {
  const { sandbox } = await fixture();
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/exit")) return Response.json({ code: null, signal: null });
    return realFetch(url, init);
  });
  const child = await sandbox.spawnDuplexProcess({ command: process.execPath, cwd: process.cwd(), args: ["-e", "process.stdin.resume()"] });
  const streams = Promise.allSettled([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    await expect(child.exited).rejects.toMatchObject({ cause: { message: "Invalid OpenSandbox child exit response" } });
  } finally {
    await child.kill("SIGKILL");
    await streams;
  }
});

it.skipIf(process.env.OMA_STDIO_LONG_TEST !== "1")("keeps a real relay child silent beyond five minutes and confirms exit", async () => {
  const { sandbox } = await fixture();
  const child = await sandbox.spawnDuplexProcess({ command: process.execPath, cwd: process.cwd(), args: ["-e", "setTimeout(() => { process.stdout.write('DONE'); process.stderr.write('cleanup'); }, 310000)"] });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    expect(await Promise.all([child.exited, output])).toEqual([
      { code: 0, signal: null }, ["DONE", "cleanup"],
    ]);
  } finally {
    await child.kill("SIGKILL");
    await output.catch(() => undefined);
  }
}, 330_000);

it("reports a failed child spawn and allows idempotent termination", async () => {
  const { sandbox } = await fixture();
  const child = await sandbox.spawnDuplexProcess({ command: process.execPath, cwd: "/openma-missing-test-directory", args: ["-e", ""] });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  expect(await child.exited).toEqual({ code: 127, signal: null });
  await child.kill();
  await Promise.all([stdout, stderr]);
});
