import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import { Readable } from "node:stream";
import { request as httpRequest } from "undici";
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
let outcome;
const startupTimer = setTimeout(() => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  server.close(() => process.exit(1));
}, 30000);
startupTimer.unref();
const finish = value => {
  outcome = value;
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
    // Short, repeatable observation of this relay's one child. The random
    // per-spawn auth token prevents a reused service port from confirming a
    // different process. Never hold headers/body open for the turn lifetime.
    if (outcome) res.end(JSON.stringify(outcome));
    else { res.writeHead(204); res.end(); }
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
    command: spec.command, args: spec.args, cwd: spec.cwd ?? sandbox.workspaceRoot,
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
  const headers = { ...endpoint.headers, "X-OpenMA-Stdio-Token": token };
  const streamsAbort = new AbortController();
  const openStream = async (path: string): Promise<ReadableStream<Uint8Array>> => {
    // fetch applies its own five-minute body deadline even without an
    // AbortSignal. Raw stdio may be silent for an entire turn; it cannot carry
    // heartbeat bytes and cannot be replayed safely after disconnect.
    const response = await httpRequest(`${endpoint.endpoint}${path}`, {
      headers, headersTimeout: 30_000, bodyTimeout: 0, signal: streamsAbort.signal,
    });
    if (response.statusCode !== 200) {
      await response.body.dump();
      throw new Error(`OpenSandbox stdio ${path} failed (HTTP ${response.statusCode})`);
    }
    return Readable.toWeb(response.body) as ReadableStream<Uint8Array>;
  };
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${endpoint.endpoint}${path}`, {
      ...init, headers,
      signal: AbortSignal.timeout(path === "/exit" ? 1_000 : 30_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenSandbox stdio relay failed (HTTP ${response.status})`); }
    return response;
  };
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await (await request("/ready")).text(); break; }
    catch (error) { if (Date.now() >= deadline) { await cleanup(); throw error; } await delay(100); }
  }
  try {
    const [stdout, stderr] = await Promise.all([
      openStream("/stdout"), openStream("/stderr"),
    ]);
    const exited = (async () => {
      let failures = 0;
      for (;;) {
        try {
          const response = await request("/exit");
          if (response.status !== 204) {
            const outcome: unknown = await response.json();
            if (!outcome || typeof outcome !== "object" ||
              !("code" in outcome) || !("signal" in outcome) ||
              !(outcome.code === null || Number.isInteger(outcome.code)) ||
              !(outcome.signal === null || typeof outcome.signal === "string") ||
              (outcome.code === null && outcome.signal === null)) {
              throw new Error("Invalid OpenSandbox child exit response");
            }
            return outcome as { code: number | null; signal: string | null };
          }
          failures = 0;
        } catch (cause) {
          if (++failures >= 3) {
            const error = new Error(`OpenSandbox exit observation failed (sandbox=${sandbox.id}, port=${port}, phase=exit_observation, at=${new Date().toISOString()}); child exit is unconfirmed`, { cause });
            streamsAbort.abort(error);
            throw error;
          }
        }
        await delay(250);
      }
    })();
    // Consumers may attach after this request fails; avoid an unhandled rejection.
    void exited.catch(() => undefined);
    const kill = async (signal: "SIGTERM" | "SIGKILL" = "SIGTERM") => {
      await (await request(`/${signal}`, { method: "DELETE" })).text();
    };
    return {
      stdout, stderr, exited, kill,
      stdin: new WritableStream<Uint8Array>({
        async write(chunk) { await (await request("/stdin", { method: "POST", body: Buffer.from(chunk) })).text(); },
        async close() { await (await request("/close", { method: "POST" })).text(); },
        async abort() { await kill("SIGKILL"); },
      }),
    };
  } catch (error) {
    streamsAbort.abort(error);
    await request("/SIGKILL", { method: "DELETE" }).then(response => response.text()).catch(() => undefined);
    throw error;
  }
}
