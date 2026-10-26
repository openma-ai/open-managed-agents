import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxDuplexProcess, SandboxDuplexProcessSpec } from "@open-managed-agents/sandbox";
import type { OpenSandbox } from "./opensandbox";

// Execd has no stdin API. A small sandbox-resident Node relay preserves raw
// stdio (unlike a PTY) over an authenticated OpenSandbox service endpoint.
// OpenMA's worker/supervisor protocol passes through unchanged.
//
// The relay script is static. The child env (which can include registered
// command secrets), the relay auth token and the port travel in an owner-only
// (0600) spec file in a private (0700) temp dir. The relay reads and unlinks
// it (and itself) before spawning the child, so neither the execd command
// string nor any process argv (/proc/*/cmdline) carries secret values.
// Passing them via the relay's own env instead would expose them in
// /proc/<pid>/environ for the relay's whole lifetime.
export const BRIDGE_SOURCE = `
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const specPath = process.argv[2];
let spec;
try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
finally {
  try { fs.rmSync(path.dirname(specPath), { recursive: true, force: true }); } catch {}
}
const token = spec.token;
const child = spawn(spec.command, spec.args || [], {
  cwd: spec.cwd || '/workspace', env: { ...process.env, ...spec.env }, detached: true,
  stdio: ['pipe', 'pipe', 'pipe']
});
let outcome, waiter;
const startupTimer = setTimeout(() => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  server.close(() => process.exit(1));
}, 30000);
startupTimer.unref();
const finish = value => {
  outcome = value;
  if (waiter) waiter.end(JSON.stringify(outcome));
  setTimeout(() => server.close(() => process.exit(0)), 30000).unref();
};
child.on('error', () => finish({ code: 127, signal: null }));
child.on('exit', (code, signal) => finish({ code, signal }));
child.stdin.on('error', () => {});
const server = http.createServer((req, res) => {
  if (req.headers['x-openma-stdio-token'] !== token) { res.writeHead(401); res.end(); return; }
  if (req.method === 'GET' && req.url === '/ready') { clearTimeout(startupTimer); res.end('ready'); return; }
  if (req.method === 'GET' && (req.url === '/stdout' || req.url === '/stderr')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-accel-buffering': 'no' });
    res.flushHeaders(); child[req.url.slice(1)].pipe(res); return;
  }
  if (req.method === 'GET' && req.url === '/exit') {
    res.setHeader('content-type', 'application/json');
    if (outcome) res.end(JSON.stringify(outcome)); else waiter = res;
    return;
  }
  if (req.method === 'POST' && req.url === '/stdin') {
    if (outcome || child.stdin.destroyed) { res.writeHead(409); res.end(); return; }
    req.pipe(child.stdin, { end: false }); req.on('end', () => res.end()); return;
  }
  if (req.method === 'POST' && req.url === '/close') { child.stdin.end(); res.end(); return; }
  if (req.method === 'DELETE' && (req.url === '/SIGTERM' || req.url === '/SIGKILL')) {
    if (outcome) { res.end(); return; }
    try { process.kill(-child.pid, req.url.slice(1)); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    res.end(); return;
  }
  res.writeHead(404); res.end();
});
server.on('error', () => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  process.exit(1);
});
server.requestTimeout = 0;
server.listen(spec.port, '0.0.0.0');
`;

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export async function spawnBridge(
  sandbox: OpenSandbox, spec: SandboxDuplexProcessSpec, port: number,
): Promise<SandboxDuplexProcess> {
  const token = Buffer.from(randomBytes(32)).toString("hex");
  const dir = `/tmp/openma-stdio-${Buffer.from(randomBytes(12)).toString("hex")}`;
  const config = {
    command: spec.command, args: spec.args, cwd: spec.cwd,
    env: sandbox.commandEnv(spec.command, spec.env), port, token,
  };
  const cleanup = () => sandbox.removeDirectory(dir).catch(() => undefined);
  try {
    await sandbox.writePrivateFiles(dir, {
      "relay.js": Buffer.from(BRIDGE_SOURCE),
      "spec.json": Buffer.from(JSON.stringify(config)),
    });
    // Only non-secret file paths appear in the command (and so in argv/execd logs).
    const execution = await sandbox.run(`node ${quote(`${dir}/relay.js`)} ${quote(`${dir}/spec.json`)}`, 120_000, true);
    if (execution.error) throw new Error("OpenSandbox stdio relay failed to start");
  } catch (error) {
    await cleanup();
    throw error;
  }
  const endpoint = await sandbox.serviceEndpoint(port);
  const request = async (path: string, init: RequestInit = {}, stream = false) => {
    const response = await fetch(`${endpoint.endpoint}${path}`, {
      ...init, headers: { ...endpoint.headers, "X-OpenMA-Stdio-Token": token },
      ...(stream ? {} : { signal: AbortSignal.timeout(30_000) }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenSandbox stdio relay failed (HTTP ${response.status})`); }
    return response;
  };
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await request("/ready"); break; }
    catch (error) { if (Date.now() >= deadline) { await cleanup(); throw error; } await delay(100); }
  }
  try {
    const [stdout, stderr] = await Promise.all([
      request("/stdout", {}, true), request("/stderr", {}, true),
    ]);
    if (!stdout.body || !stderr.body) throw new Error("OpenSandbox stdio relay returned no stream");
    const exited = request("/exit", {}, true).then(async (response) => {
      return await response.json() as { code: number | null; signal: string | null };
    });
    // Consumers may attach after this request fails; avoid an unhandled rejection.
    void exited.catch(() => undefined);
    const kill = async (signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
      await request(`/${signal}`, { method: "DELETE" });
    };
    return {
      stdout: stdout.body, stderr: stderr.body, exited, kill,
      stdin: new WritableStream<Uint8Array>({
        async write(chunk) { await request("/stdin", { method: "POST", body: Buffer.from(chunk) }); },
        async close() { await request("/close", { method: "POST" }); },
        async abort() { await kill("SIGKILL"); },
      }),
    };
  } catch (error) {
    await request("/SIGKILL", { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
}
