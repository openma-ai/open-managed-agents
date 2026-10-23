// Native OpenSandbox lifecycle + execd OpenAPI adapter. Provider credentials
// are used only on lifecycle requests, never in the sandbox environment.
import { randomInt } from "node:crypto";
import { Buffer } from "node:buffer";
import { setTimeout as delay } from "node:timers/promises";
import type {
  SandboxCheckpointHandle, SandboxDuplexProcessPort, SandboxDuplexProcessSpec,
  SandboxFactory, SandboxFactoryEnv, SandboxPort, SandboxProviderPort,
  SandboxRuntimeHandle, SandboxRuntimePort, SandboxRuntimeStatus,
} from "@open-managed-agents/sandbox";
import { spawnBridge } from "./stdio-bridge";

class OpenSandboxHttpError extends Error {
  constructor(readonly status: number) { super(`OpenSandbox request failed (HTTP ${status})`); }
}

interface Endpoint { endpoint: string; headers?: Record<string, string> }
interface SandboxInfo { id: string; status: { state: string } }
interface StreamEvent {
  type: string;
  text?: string;
  exit_code?: number;
  error?: { evalue?: string; exit_code?: number };
}

export interface OpenSandboxOptions {
  baseUrl: string;
  apiKey?: string;
  image: string;
  timeoutSeconds: number;
  readyTimeoutMs: number;
  cpu: string;
  memory: string;
}

function positive(value: string | undefined, fallback: number, name: string, min = 1): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

export function optionsFromEnvironment(env: SandboxFactoryEnv): OpenSandboxOptions {
  const baseUrl = env.OPENSANDBOX_BASE_URL
    ?? `${env.OPENSANDBOX_PROTOCOL ?? "http"}://${env.OPENSANDBOX_DOMAIN ?? "localhost:8080"}/v1`;
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("OPENSANDBOX_BASE_URL must be an HTTP(S) API base URL without credentials, query or fragment");
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: env.OPENSANDBOX_API_KEY ?? env.OPEN_SANDBOX_API_KEY,
    image: env.SANDBOX_IMAGE ?? "node:22-slim",
    timeoutSeconds: positive(env.OPENSANDBOX_TIMEOUT_SECONDS, 1800, "OPENSANDBOX_TIMEOUT_SECONDS", 60),
    readyTimeoutMs: positive(env.OPENSANDBOX_READY_TIMEOUT_MS, 120_000, "OPENSANDBOX_READY_TIMEOUT_MS"),
    cpu: env.OPENSANDBOX_CPU ?? "1",
    memory: env.OPENSANDBOX_MEMORY ?? "1Gi",
  };
}

export class OpenSandbox implements SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort {
  private env: Record<string, string> = {};
  private secrets: Array<{ prefix: string; values: Record<string, string> }> = [];
  private endpoint?: Endpoint;
  private destroyed = false;

  constructor(readonly id: string, private readonly options: OpenSandboxOptions) {}

  private async request(url: string, headers: Record<string, string>, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: { ...headers, ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      // Do not echo response bodies, URLs or headers: gateways may include credentials.
      await response.body?.cancel();
      throw new OpenSandboxHttpError(response.status);
    }
    return response;
  }

  async lifecycle(path = "", init: RequestInit = {}): Promise<Response> {
    return this.request(`${this.options.baseUrl}/sandboxes/${encodeURIComponent(this.id)}${path}`, {
      ...(this.options.apiKey ? { "OPEN-SANDBOX-API-KEY": this.options.apiKey } : {}),
    }, init);
  }

  async serviceEndpoint(port: number): Promise<Endpoint> {
    const endpoint = await (await this.lifecycle(`/endpoints/${port}`)).json() as Endpoint;
    const url = new URL(endpoint.endpoint.includes("://")
      ? endpoint.endpoint : `${new URL(this.options.baseUrl).protocol}//${endpoint.endpoint}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("OpenSandbox returned an invalid service endpoint");
    }
    return { ...endpoint, endpoint: url.href.replace(/\/$/, "") };
  }

  async execd(path: string, init: RequestInit = {}): Promise<Response> {
    if (this.destroyed) throw new Error("OpenSandbox has been destroyed");
    this.endpoint ??= await this.serviceEndpoint(44772);
    return this.request(`${this.endpoint.endpoint}${path}`, this.endpoint.headers ?? {}, init);
  }

  async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.options.readyTimeoutMs;
    const signal = AbortSignal.timeout(this.options.readyTimeoutMs);
    while (true) {
      const state = await this.status(signal);
      if (state === "running") break;
      if (state === "suspended") throw new Error("OpenSandbox runtime is paused; resume it on the server before attaching");
      if (state === "stopped") throw new Error("OpenSandbox stopped during provisioning");
      if (Date.now() >= deadline) throw new Error("OpenSandbox provisioning timed out");
      await delay(250, undefined, { signal });
    }
    // Lifecycle Running precedes execd readiness on some runtimes.
    while (true) {
      try { await this.execd("/ping", { signal }); break; }
      catch (error) {
        if (Date.now() >= deadline) throw error;
        this.endpoint = undefined;
        await delay(250, undefined, { signal });
      }
    }
    await this.execd("/directories", { ...json({ "/workspace": { mode: 755 } }), signal });
  }

  runtimeHandle(): SandboxRuntimeHandle { return { provider: "opensandbox", runtimeId: this.id }; }
  runtimeCapabilities() { return { lease: true, suspend: [], checkpoint: [] }; }
  async status(signal?: AbortSignal): Promise<SandboxRuntimeStatus> {
    if (this.destroyed) return "stopped";
    let response: Response;
    try { response = await this.lifecycle("", { signal }); }
    catch (error) {
      if (error instanceof OpenSandboxHttpError && error.status === 404) return "stopped";
      throw error;
    }
    const info = await response.json() as SandboxInfo;
    switch (info.status.state.toLowerCase()) {
      case "running": return "running";
      case "paused": return "suspended";
      case "terminated": case "failed": case "deleted": return "stopped";
      default: return "unknown";
    }
  }
  async renewLease({ ttlMs }: { ttlMs: number }): Promise<void> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be a positive integer");
    await this.lifecycle("/renew-expiration", json({ expiresAt: new Date(Date.now() + ttlMs).toISOString() }));
  }
  async suspend(): Promise<SandboxCheckpointHandle> { throw new Error("OpenSandbox suspend is not supported by this adapter"); }
  async resume(): Promise<void> { throw new Error("OpenSandbox checkpoint resume is not supported by this adapter"); }
  async checkpoint(): Promise<SandboxCheckpointHandle> { throw new Error("OpenSandbox checkpoints are not supported by this adapter"); }

  async setEnvVars(env: Record<string, string>): Promise<void> { Object.assign(this.env, env); }
  registerCommandSecrets(prefix: string, values: Record<string, string>): void { this.secrets.push({ prefix, values }); }
  commandEnv(command: string, env?: Record<string, string | undefined>): Record<string, string> {
    const result = { ...this.env };
    for (const item of this.secrets) if (command.startsWith(item.prefix)) Object.assign(result, item.values);
    for (const [key, value] of Object.entries(env ?? {})) if (value !== undefined) result[key] = value;
    return result;
  }

  async run(command: string, timeout = 120_000, background = false): Promise<StreamEvent[]> {
    const response = await this.execd("/command", {
      ...json({ command, cwd: "/workspace", ...(background ? {} : { timeout }), background, envs: this.commandEnv(command) }),
      signal: AbortSignal.timeout(timeout + 30_000),
    });
    return readEvents(response);
  }
  async exec(command: string, timeout?: number): Promise<string> {
    const events = await this.run(command, timeout);
    let stdout = "", stderr = "", exitCode = 0;
    for (const event of events) {
      if (event.type === "stdout") stdout += event.text ?? "";
      if (event.type === "stderr") stderr += event.text ?? "";
      if (event.exit_code !== undefined && event.exit_code !== 0) exitCode = event.exit_code;
      if (event.error) {
        const code = event.error.exit_code ?? Number(event.error.evalue);
        if (!Number.isInteger(code) || code === 0) throw new Error("OpenSandbox command failed to execute");
        exitCode = code;
      }
    }
    const combined = (stdout + (stderr ? `${stdout && !stdout.endsWith("\n") ? "\n" : ""}${stderr}` : "")).trimEnd();
    return combined + (exitCode ? `\n[exit ${exitCode}]` : "");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await (await this.execd(`/files/download?path=${encodeURIComponent(normalise(path))}`)).arrayBuffer());
  }
  async readFile(path: string): Promise<string> { return Buffer.from(await this.readFileBytes(path)).toString("utf8"); }
  async writeFile(path: string, content: string): Promise<string> { return this.writeFileBytes(path, Buffer.from(content)); }
  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const target = normalise(path);
    await this.execd("/directories", json({ [target.slice(0, target.lastIndexOf("/")) || "/"]: { mode: 755 } }));
    const form = new FormData();
    form.append("metadata", JSON.stringify({ path: target, mode: 644 }));
    form.append("file", new Blob([new Uint8Array(bytes)]), "file");
    await this.execd("/files/upload", { method: "POST", body: form });
    return target;
  }
  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec) {
    return spawnBridge(this, spec, randomInt(45000, 65000));
  }
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    try { await this.lifecycle("", { method: "DELETE" }); }
    catch (error) {
      if (!(error instanceof OpenSandboxHttpError && error.status === 404)) throw error;
    }
    this.destroyed = true;
  }
}

function normalise(path: string): string { return path.startsWith("/") ? path : `/workspace/${path}`; }
function json(body: unknown): RequestInit { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }

/** Parse incrementally: SSE records may cross network chunks or contain multiple data lines. */
async function readEvents(response: Response): Promise<StreamEvent[]> {
  if (!response.body) throw new Error("OpenSandbox returned an empty command stream");
  const events: StreamEvent[] = [];
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  const record = (value: string) => {
    const data = value.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data) events.push(JSON.parse(data) as StreamEvent);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += value;
      pending = pending.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        record(pending.slice(0, boundary)); pending = pending.slice(boundary + 2);
      }
    }
    if (pending.trim()) record(pending);
  } finally { reader.releaseLock(); }
  if (!events.some((event) => event.type === "execution_complete")) {
    throw new Error("OpenSandbox command stream ended before execution_complete");
  }
  return events;
}

export const sandboxProvider: SandboxProviderPort<OpenSandbox> = {
  async create(ctx, env) {
    const options = optionsFromEnvironment(env);
    const response = await fetch(`${options.baseUrl}/sandboxes`, {
      ...json({ image: { uri: options.image }, timeout: options.timeoutSeconds,
        resourceLimits: { cpu: options.cpu, memory: options.memory },
        entrypoint: ["tail", "-f", "/dev/null"], metadata: { "oma-session-id": ctx.sessionId } }),
      headers: { "Content-Type": "application/json", ...(options.apiKey ? { "OPEN-SANDBOX-API-KEY": options.apiKey } : {}) },
      signal: AbortSignal.timeout(options.readyTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OpenSandbox create failed (HTTP ${response.status})`);
    }
    const info = await response.json() as SandboxInfo;
    if (!info.id) throw new Error("OpenSandbox create response has no sandbox id");
    const sandbox = new OpenSandbox(info.id, options);
    try { await sandbox.waitUntilReady(); return sandbox; }
    catch (error) { await sandbox.destroy().catch(() => undefined); throw error; }
  },
  async resume(handle, _ctx, env) {
    if (handle.provider !== "opensandbox" || !handle.runtimeId) throw new Error("Incompatible OpenSandbox runtime handle");
    const sandbox = new OpenSandbox(handle.runtimeId, optionsFromEnvironment(env));
    await sandbox.waitUntilReady();
    return sandbox;
  },
  async restore() { throw new Error("OpenSandbox portable restore is not supported by this adapter"); },
};
export const sandboxFactory: SandboxFactory = (ctx, env) => sandboxProvider.create(ctx, env);
