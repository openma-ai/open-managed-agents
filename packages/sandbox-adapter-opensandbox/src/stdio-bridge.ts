import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxDuplexProcess, SandboxDuplexProcessSpec } from "@open-managed-agents/sandbox";
import type { OpenSandbox } from "./opensandbox";

// Execd has no stdin API. A small sandbox-resident Node relay preserves raw
// stdio (unlike a PTY) over an authenticated OpenSandbox service endpoint.
// OpenMA's worker/supervisor protocol passes through unchanged.
export function bridgeSource(spec: SandboxDuplexProcessSpec, port: number, token: string): string {
  return `
const http = require('node:http');
const { spawn } = require('node:child_process');
const spec = ${JSON.stringify(spec)};
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
  if (req.headers['x-openma-stdio-token'] !== ${JSON.stringify(token)}) { res.writeHead(401); res.end(); return; }
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
server.listen(${port}, '0.0.0.0');
`;
}

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export async function spawnBridge(
  sandbox: OpenSandbox, spec: SandboxDuplexProcessSpec, port: number,
): Promise<SandboxDuplexProcess> {
  const token = Buffer.from(randomBytes(32)).toString("hex");
  const source = bridgeSource({ ...spec, env: sandbox.commandEnv(spec.command, spec.env) }, port, token);
  const execution = await sandbox.run(`node -e ${quote(source)}`, 120_000, true);
  if (execution.error) throw new Error("OpenSandbox stdio relay failed to start");
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
    catch (error) { if (Date.now() >= deadline) throw error; await delay(100); }
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
