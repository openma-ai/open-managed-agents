import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
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
  const sandbox = new OpenSandbox("sb-1", optionsFromEnvironment({}));
  const run = vi.spyOn(sandbox, "run").mockImplementation(async (command) => {
    // Redirect only the exposed service port so this test needs no OpenSandbox
    // server. Run the exact relay command produced by the adapter.
    command = command.replace(/server\.listen\(\d+,/, `server.listen(${port},`);
    relay = spawn(command, { shell: true, detached: true, stdio: "ignore" });
    return [{ type: "execution_complete" }];
  });
  vi.spyOn(sandbox, "serviceEndpoint").mockResolvedValue({ endpoint: `http://127.0.0.1:${port}` });
  return { sandbox, port, run };
}

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


it("reports a failed child spawn and allows idempotent termination", async () => {
  const { sandbox } = await fixture();
  const child = await sandbox.spawnDuplexProcess({ command: process.execPath, cwd: "/openma-missing-test-directory", args: ["-e", ""] });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  expect(await child.exited).toEqual({ code: 127, signal: null });
  await child.kill();
  await Promise.all([stdout, stderr]);
});
