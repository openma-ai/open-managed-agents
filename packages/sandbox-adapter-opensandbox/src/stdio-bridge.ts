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
// Attach the child pipes before the first command can exit. Without an
// intermediate readable, a short-lived child can finish and destroy its
// stdout/stderr streams before the HTTP consumers connect, losing output.
const { PassThrough } = require('node:stream');
const output = { stdout: new PassThrough(), stderr: new PassThrough() };
// Keep a byte history so a service connection reset can resume from the
// consumer's acknowledged offset instead of replaying or losing ACP bytes.
const maxOutputHistory = 64 * 1024 * 1024;
const outputState = {
  stdout: { chunks: [], size: 0, ended: false, clients: new Set() },
  stderr: { chunks: [], size: 0, ended: false, clients: new Set() },
};
const appendOutput = (state, chunk) => {
  const data = Buffer.from(chunk);
  if (data.length === 0) return;
  state.chunks.push({ start: state.size, data });
  state.size += data.length;
  while (state.chunks.length && state.size - state.chunks[0].start > maxOutputHistory) {
    const first = state.chunks[0];
    const trim = state.size - maxOutputHistory - first.start;
    if (trim >= first.data.length) state.chunks.shift();
    else { first.data = first.data.subarray(trim); first.start += trim; }
  }
  for (const client of state.clients) pumpOutput(state, client);
};
const finishOutput = state => {
  state.ended = true;
  for (const client of state.clients) pumpOutput(state, client);
};
const pumpOutput = (state, client) => {
  if (client.pumping || client.closed) return;
  const earliest = state.chunks[0]?.start ?? state.size;
  if (client.cursor < earliest) {
    client.closed = true;
    state.clients.delete(client);
    client.res.destroy();
    return;
  }
  client.pumping = true;
  while (!client.closed && client.cursor < state.size) {
    const entry = state.chunks.find(item => client.cursor < item.start + item.data.length);
    if (!entry) break;
    const data = entry.data.subarray(Math.max(0, client.cursor - entry.start));
    client.cursor += data.length;
    if (!client.res.write(data)) {
      client.pumping = false;
      client.res.once('drain', () => pumpOutput(state, client));
      return;
    }
  }
  client.pumping = false;
  if (!client.closed && state.ended && client.cursor >= state.size) {
    client.closed = true;
    state.clients.delete(client);
    client.res.end();
  }
};
for (const name of ['stdout', 'stderr']) {
  output[name].on('data', chunk => appendOutput(outputState[name], chunk));
  output[name].on('end', () => finishOutput(outputState[name]));
}
child.stdout.pipe(output.stdout);
child.stderr.pipe(output.stderr);
let stdinSequence = -1;
let stdinClosed = false;
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
  const requestUrl = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (requestUrl.pathname === '/stdout' || requestUrl.pathname === '/stderr')) {
    const name = requestUrl.pathname.slice(1);
    const state = outputState[name];
    const offset = Number(req.headers['x-openma-stdio-offset'] || requestUrl.searchParams.get('offset') || 0);
    const earliest = state.chunks[0]?.start ?? state.size;
    if (!Number.isSafeInteger(offset) || offset < earliest || offset > state.size) { res.writeHead(416); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const client = { res, cursor: offset, pumping: false, closed: false };
    state.clients.add(client);
    res.on('close', () => { client.closed = true; state.clients.delete(client); });
    pumpOutput(state, client);
    return;
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
    const sequence = Number(req.headers['x-openma-stdio-sequence']);
    if (!Number.isSafeInteger(sequence) || sequence < 0) { res.writeHead(400); res.end(); return; }
    if (sequence <= stdinSequence) { res.end(); return; }
    if (sequence !== stdinSequence + 1) { res.writeHead(409); res.end(); return; }
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      if (sequence <= stdinSequence) { res.end(); return; }
      const data = Buffer.concat(chunks);
      if (data.length === 0) {
        stdinSequence = sequence;
        res.end();
        return;
      }
      child.stdin.write(data, error => {
        if (error) { res.writeHead(409); res.end(); return; }
        stdinSequence = sequence;
        res.end();
      });
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/close') { if (!stdinClosed) { stdinClosed = true; child.stdin.end(); } res.end(); return; }
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

/** OpenSandbox briefly tears down service connections while a checkpoint
 * pauses the sandbox. Keep the consumer's Web stream stable while the relay
 * endpoint is reopened, so ACP does not mistake that handoff for child exit. */
export interface CheckpointableDuplexProcess extends SandboxDuplexProcess {
  suspendForCheckpoint(): Promise<() => Promise<void>>;
}

class ReconnectableOutput {
  readonly stream: ReadableStream<Uint8Array>;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private connecting: Promise<void> | undefined;
  private resumeGate: Promise<void> | undefined;
  private resolveResume: (() => void) | undefined;
  private rejectResume: ((error: unknown) => void) | undefined;
  private phase: "active" | "suspended" | "resuming" = "active";
  private closed = false;
  private failureReported = false;
  /** Cumulative bytes already handed to ACP; reconnects resume at this offset. */
  private deliveredBytes = 0;

  constructor(
    private readonly open: (offset: number) => Promise<ReadableStream<Uint8Array>>,
    private readonly onFailure: (error: unknown) => void,
    private readonly isTerminal: () => boolean,
  ) {
    this.stream = new ReadableStream<Uint8Array>({
      pull: (controller) => this.pull(controller),
      cancel: (reason) => this.cancel(reason),
    }, { highWaterMark: 0 });
  }

  async ready(): Promise<void> {
    try {
      await this.connect();
      if (this.reader === undefined) throw new Error("OpenSandbox stdio stream did not connect");
    } catch (error) {
      // The first service connection can be lost independently of a
      // checkpoint. Give a transient route/socket failure the same bounded
      // reconnect treatment as a later read failure.
      await this.reconnectAfterFailure(error);
    }
  }

  async suspendForCheckpoint(): Promise<() => Promise<void>> {
    if (this.closed) return async () => {};
    if (this.phase !== "active") {
      await this.resumeGate;
      if (this.closed) return async () => {};
    }
    this.phase = "suspended";
    this.resumeGate = new Promise<void>((resolve, reject) => {
      this.resolveResume = resolve;
      this.rejectResume = reject;
    });
    void this.resumeGate.catch(() => undefined);
    const reader = this.reader;
    this.reader = undefined;
    await reader?.cancel(new Error("OpenSandbox checkpoint handoff")).catch(() => undefined);
    let resumed = false;
    return async () => {
      if (resumed || this.closed) return;
      resumed = true;
      this.phase = "resuming";
      try {
        await this.connectWithRetry();
        this.phase = "active";
        this.resolveResume?.();
      } catch (error) {
        this.phase = "active";
        this.rejectResume?.(error);
        this.fail(error);
        throw error;
      } finally {
        this.resumeGate = undefined;
        this.resolveResume = undefined;
        this.rejectResume = undefined;
      }
    };
  }

  private async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    while (!this.closed) {
      try {
        if (this.phase !== "active") await this.resumeGate;
        if (this.closed) return;
        await this.connect();
        const reader = this.reader;
        if (reader === undefined) continue;
        const item = await reader.read();
        this.reader = undefined;
        if (item.done) {
          if (this.phase !== "active") continue;
          if (this.isTerminal()) {
            this.closed = true;
            controller.close();
            return;
          }
          await this.reconnectAfterFailure(new Error("OpenSandbox stdio stream ended before child exit"));
          continue;
        }
        this.reader = reader;
        this.deliveredBytes += item.value.byteLength;
        controller.enqueue(item.value);
        return;
      } catch (error) {
        this.reader = undefined;
        if (this.phase !== "active") continue;
        try {
          await this.reconnectAfterFailure(error);
        } catch (reconnectError) {
          this.fail(reconnectError, controller);
          return;
        }
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.closed || this.phase === "suspended" || this.reader !== undefined) return;
    if (this.connecting !== undefined) return this.connecting;
    this.connecting = (async () => {
      const source = await this.open(this.deliveredBytes);
      if (this.closed || this.phase === "suspended") {
        await source.cancel().catch(() => undefined);
        return;
      }
      this.reader = source.getReader();
    })();
    try { await this.connecting; }
    finally { this.connecting = undefined; }
  }

  private async connectWithRetry(): Promise<void> {
    const deadline = Date.now() + 60_000;
    let waitMs = 100;
    let lastError: unknown;
    while (Date.now() < deadline && !this.closed) {
      try {
        await this.connect();
        if (this.reader !== undefined) return;
      } catch (error) { lastError = error; }
      await delay(waitMs);
      waitMs = Math.min(2_000, waitMs * 2);
    }
    throw lastError instanceof Error ? lastError : new Error("OpenSandbox stdio stream did not reconnect after checkpoint");
  }

  private async reconnectAfterFailure(cause: unknown): Promise<void> {
    let lastError: unknown = cause;
    let waitMs = 100;
    for (let attempt = 0; attempt < 3 && !this.closed; attempt++) {
      try {
        await this.connect();
        if (this.reader !== undefined) return;
      } catch (error) { lastError = error; }
      if (attempt < 2) {
        await delay(waitMs);
        waitMs = Math.min(1_000, waitMs * 2);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OpenSandbox stdio stream did not reconnect");
  }

  private async cancel(reason: unknown): Promise<void> {
    this.closed = true;
    this.phase = "active";
    this.rejectResume?.(reason);
    const reader = this.reader;
    this.reader = undefined;
    await reader?.cancel(reason).catch(() => undefined);
  }

  private fail(error: unknown, controller?: ReadableStreamDefaultController<Uint8Array>): void {
    this.closed = true;
    this.phase = "active";
    this.rejectResume?.(error);
    void this.reader?.cancel(error).catch(() => undefined);
    this.reader = undefined;
    if (!this.failureReported) {
      this.failureReported = true;
      this.onFailure(error);
    }
    try { controller?.error(error); } catch { /* consumer already cancelled */ }
  }
}

export async function spawnBridge(
  sandbox: OpenSandbox, spec: SandboxDuplexProcessSpec, port: number,
): Promise<CheckpointableDuplexProcess> {
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
  const endpointWithRetry = async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await sandbox.serviceEndpoint(port); }
      catch (error) {
        lastError = error;
        if (attempt < 2) await delay(100 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OpenSandbox service endpoint unavailable");
  };
  let endpoint = await endpointWithRetry();
  const headers = () => ({ ...endpoint.headers, "X-OpenMA-Stdio-Token": token });
  const refreshEndpoint = async () => { endpoint = await endpointWithRetry(); };
  const streamsAbort = new AbortController();
  const openStream = async (path: string, offset = 0): Promise<ReadableStream<Uint8Array>> => {
    // fetch applies its own five-minute body deadline even without an
    // AbortSignal. Raw stdio may be silent for an entire turn; it cannot carry
    // heartbeat bytes. The relay retains a bounded byte history and accepts
    // the delivered offset so a reconnect can resume without replaying data.
    const response = await httpRequest(`${endpoint.endpoint}${path}`, {
      headers: { ...headers(), "X-OpenMA-Stdio-Offset": String(offset) }, headersTimeout: 30_000, bodyTimeout: 0, signal: streamsAbort.signal,
    });
    if (response.statusCode !== 200) {
      await response.body.dump();
      throw new Error(`OpenSandbox stdio ${path} failed (HTTP ${response.statusCode})`);
    }
    return Readable.toWeb(response.body) as unknown as ReadableStream<Uint8Array>;
  };
  const request = async (path: string, init: RequestInit = {}) => {
    const requestHeaders = new Headers(headers());
    for (const [name, value] of new Headers(init.headers)) requestHeaders.set(name, value);
    const response = await fetch(`${endpoint.endpoint}${path}`, {
      ...init, headers: requestHeaders,
      signal: AbortSignal.timeout(path === "/exit" ? 1_000 : 30_000),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenSandbox stdio relay failed (HTTP ${response.status})`); }
    return response;
  };
  const retryableRequest = async (path: string, init: RequestInit = {}): Promise<Response> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await request(path, init); }
      catch (error) {
        lastError = error;
        const statusMatch = error instanceof Error ? error.message.match(/HTTP (\d+)/) : undefined;
        const status = statusMatch === null || statusMatch === undefined ? undefined : Number(statusMatch[1]);
        const retryableStatus = status === undefined || [408, 425, 429, 500, 502, 503, 504].includes(status);
        if (!retryableStatus || attempt === 2) throw error;
        await refreshEndpoint().catch(() => undefined);
        await delay(100 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OpenSandbox relay request failed");
  };
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await (await request("/ready")).text(); break; }
    catch (error) {
      if (Date.now() >= deadline) { await cleanup(); throw error; }
      await refreshEndpoint().catch(() => undefined);
      await delay(100);
    }
  }
  try {
    let checkpointing = false;
    let exitObserved = false;
    const onStreamFailure = (error: unknown) => streamsAbort.abort(error);
    const stdout = new ReconnectableOutput(async (offset) => { await refreshEndpoint(); return openStream("/stdout", offset); }, onStreamFailure, () => exitObserved);
    const stderr = new ReconnectableOutput(async (offset) => { await refreshEndpoint(); return openStream("/stderr", offset); }, onStreamFailure, () => exitObserved);
    await Promise.all([stdout.ready(), stderr.ready()]);
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
            exitObserved = true;
            return outcome as { code: number | null; signal: string | null };
          }
          failures = 0;
        } catch (cause) {
          if (checkpointing) {
            await refreshEndpoint().catch(() => undefined);
            await delay(250);
            continue;
          }
          await refreshEndpoint().catch(() => undefined);
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
      await (await retryableRequest(`/${signal}`, { method: "DELETE" })).text();
    };
    let nextStdinSequence = 0;
    const suspendForCheckpoint = async () => {
      if (checkpointing) return async () => {};
      checkpointing = true;
      let resumeStdout: (() => Promise<void>) | undefined;
      let resumeStderr: (() => Promise<void>) | undefined;
      try {
        resumeStdout = await stdout.suspendForCheckpoint();
        resumeStderr = await stderr.suspendForCheckpoint();
      } catch (error) {
        checkpointing = false;
        await resumeStderr?.().catch(() => undefined);
        await resumeStdout?.().catch(() => undefined);
        throw error;
      }
      let resumed = false;
      return async () => {
        if (resumed) return;
        resumed = true;
        try {
          await Promise.all([resumeStdout?.(), resumeStderr?.()]);
        } finally { checkpointing = false; }
      };
    };
    return {
      stdout: stdout.stream, stderr: stderr.stream, exited, kill, suspendForCheckpoint,
      stdin: new WritableStream<Uint8Array>({
        async write(chunk) {
          const sequence = nextStdinSequence;
          await (await retryableRequest("/stdin", {
            method: "POST", body: Buffer.from(chunk),
            headers: { "X-OpenMA-Stdio-Sequence": String(sequence) },
          })).text();
          nextStdinSequence += 1;
        },
        async close() { await (await retryableRequest("/close", { method: "POST" })).text(); },
        async abort() { await kill("SIGKILL"); },
      }),
    };
  } catch (error) {
    streamsAbort.abort(error);
    await retryableRequest("/SIGKILL", { method: "DELETE" }).then(response => response.text()).catch(() => undefined);
    throw error;
  }
}
