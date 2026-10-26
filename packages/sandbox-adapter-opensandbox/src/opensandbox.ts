// OpenMA ports backed by the official OpenSandbox SDK. Provider credentials
// stay in the control-plane connection config, never in the sandbox environment.
import { randomInt } from "node:crypto";
import { Buffer } from "node:buffer";
import type { CommandExecution, Sandbox as SdkSandbox } from "@alibaba-group/opensandbox";
import type {
  SandboxCheckpointHandle, SandboxCheckpointKind, SandboxDuplexProcessPort, SandboxDuplexProcessSpec,
  SandboxFactory, SandboxFactoryEnv, SandboxPort, SandboxProviderPort,
  SandboxRuntimeHandle, SandboxRuntimePort, SandboxRuntimeStatus,
} from "@open-managed-agents/sandbox";
import { spawnBridge } from "./stdio-bridge";

export interface OpenSandboxOptions {
  domain: string;
  protocol: "http" | "https";
  apiKey?: string;
  image: string;
  timeoutSeconds: number;
  readyTimeoutMs: number;
  cpu: string;
  memory: string;
  snapshotTimeoutMs: number;
  snapshotPollMs: number;
  suspendedTtlSeconds: number;
}

function positive(value: string | undefined, fallback: number, name: string, min = 1): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

export function optionsFromEnvironment(env: SandboxFactoryEnv): OpenSandboxOptions {
  const domain = env.OPENSANDBOX_DOMAIN ?? "localhost:8080";
  const protocol = env.OPENSANDBOX_PROTOCOL ?? "http";
  if (protocol !== "http" && protocol !== "https") throw new Error("OPENSANDBOX_PROTOCOL must be http or https");
  let url: URL;
  try { url = new URL(`${protocol}://${domain}`); }
  catch { throw new Error("OPENSANDBOX_DOMAIN must be a server host[:port]"); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("OPENSANDBOX_DOMAIN must be a server host[:port] without credentials, path, query or fragment");
  }
  return {
    domain, protocol,
    apiKey: env.OPENSANDBOX_API_KEY ?? env.OPEN_SANDBOX_API_KEY,
    image: env.SANDBOX_IMAGE ?? "node:22-slim",
    timeoutSeconds: positive(env.OPENSANDBOX_TIMEOUT_SECONDS, 1800, "OPENSANDBOX_TIMEOUT_SECONDS", 60),
    readyTimeoutMs: positive(env.OPENSANDBOX_READY_TIMEOUT_MS, 120_000, "OPENSANDBOX_READY_TIMEOUT_MS"),
    cpu: env.OPENSANDBOX_CPU ?? "1",
    memory: env.OPENSANDBOX_MEMORY ?? "1Gi",
    snapshotTimeoutMs: positive(env.OPENSANDBOX_SNAPSHOT_TIMEOUT_MS, 600_000, "OPENSANDBOX_SNAPSHOT_TIMEOUT_MS"),
    snapshotPollMs: positive(env.OPENSANDBOX_SNAPSHOT_POLL_MS, 1_000, "OPENSANDBOX_SNAPSHOT_POLL_MS"),
    // OpenSandbox expiry deletes paused sandboxes too, and the last lease
    // renewal (host heartbeat TTL) is usually short. Suspend extends it.
    suspendedTtlSeconds: positive(env.OPENSANDBOX_SUSPENDED_TTL_SECONDS, 86_400, "OPENSANDBOX_SUSPENDED_TTL_SECONDS", 60),
  };
}

async function loadSdk() {
  return import(/* @vite-ignore */ "@alibaba-group/opensandbox" as string)
    .catch(() => { throw new Error("OpenSandbox provider requires '@alibaba-group/opensandbox'; install it in the selected deployment"); }) as Promise<typeof import("@alibaba-group/opensandbox")>;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return undefined;
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function providerError(operation: string, error: unknown): Error {
  const status = statusCode(error);
  // SDK exceptions can include upstream bodies, URLs and headers. Keep those
  // out of Session events, including when an upstream gateway echoes a key.
  return new Error(`OpenSandbox ${operation} failed${status === undefined ? "" : ` (HTTP ${status})`}`);
}

function configuration(sdk: Awaited<ReturnType<typeof loadSdk>>, options: OpenSandboxOptions) {
  return new sdk.ConnectionConfig({
    domain: options.domain,
    protocol: options.protocol,
    apiKey: options.apiKey,
    requestTimeoutSeconds: 60,
    disableMetrics: true,
  });
}

export class OpenSandbox implements SandboxPort, SandboxRuntimePort, SandboxDuplexProcessPort {
  private env: Record<string, string> = {};
  private secrets: Array<{ prefix: string; values: Record<string, string> }> = [];
  private destroyed = false;
  readonly id: string;

  constructor(private client: SdkSandbox, private readonly options: OpenSandboxOptions) {
    this.id = client.id;
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.destroyed) throw new Error("OpenSandbox has been destroyed");
    try { return await operation(); }
    catch (error) { throw providerError("request", error); }
  }

  async serviceEndpoint(port: number) {
    const endpoint = await this.call(() => this.client.getEndpoint(port));
    const url = new URL(endpoint.endpoint.includes("://")
      ? endpoint.endpoint : `${this.options.protocol}://${endpoint.endpoint}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("OpenSandbox returned an invalid service endpoint");
    }
    return { endpoint: url.href.replace(/\/$/, ""), headers: endpoint.headers };
  }

  runtimeHandle(): SandboxRuntimeHandle { return { provider: "opensandbox", runtimeId: this.id }; }
  // Docker/Kubernetes pause keeps the same resource (container freeze keeps
  // memory and processes). Snapshots are filesystem images: restoring one
  // creates a new runtime and does not carry process or memory state.
  runtimeCapabilities() { return { lease: true, suspend: ["filesystem", "memory"] as const, checkpoint: ["filesystem"] as const }; }
  async status(signal?: AbortSignal): Promise<SandboxRuntimeStatus> {
    if (this.destroyed) return "stopped";
    signal?.throwIfAborted();
    let state: string;
    try { state = (await this.client.getInfo()).status.state.toLowerCase(); }
    catch (error) {
      if (statusCode(error) === 404) return "stopped";
      throw providerError("request", error);
    }
    switch (state) {
      case "running": return "running";
      case "paused": return "suspended";
      case "terminated": case "failed": case "deleted": return "stopped";
      default: return "unknown";
    }
  }
  async renewLease({ ttlMs }: { ttlMs: number }): Promise<void> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("ttlMs must be a positive integer");
    await this.call(() => this.client.renew(ttlMs / 1000));
  }
  async suspend({ kind }: { kind: SandboxCheckpointKind }): Promise<SandboxCheckpointHandle> {
    if (kind !== "filesystem" && kind !== "memory") throw new Error("Unsupported OpenSandbox suspend kind");
    // The server's expiry timer keeps running while paused and deletes the
    // sandbox. Extend first so a failed renewal never leaves a doomed pause.
    await this.call(() => this.client.renew(this.options.suspendedTtlSeconds));
    await this.call(() => this.client.pause());
    return { provider: "opensandbox", checkpointId: this.id, sourceRuntimeId: this.id, kind, scope: "runtime" };
  }
  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    if (checkpoint.provider !== "opensandbox" || checkpoint.scope !== "runtime"
      || checkpoint.checkpointId !== this.id || checkpoint.sourceRuntimeId !== this.id) {
      throw new Error("OpenSandbox runtime can only resume its own runtime-scoped checkpoint");
    }
    const state = await this.status();
    if (state === "running") return;
    if (state !== "suspended") throw new Error(`OpenSandbox runtime cannot be resumed from state ${state}`);
    const previous = this.client;
    const resumed = await this.call(() => previous.resume({ readyTimeoutSeconds: this.options.readyTimeoutMs / 1000 }));
    this.client = resumed;
    await previous.close().catch(() => undefined);
    await this.call(() => resumed.renew(this.options.timeoutSeconds));
  }
  async checkpoint({ kind, name }: { kind: SandboxCheckpointKind; name?: string }): Promise<SandboxCheckpointHandle> {
    if (kind !== "filesystem") throw new Error("OpenSandbox snapshots capture filesystem state only");
    if (this.destroyed) throw new Error("OpenSandbox has been destroyed");
    const sdk = await loadSdk();
    const manager = sdk.SandboxManager.create({ connectionConfig: configuration(sdk, this.options) });
    try {
      let snapshot = await manager.createSnapshot(this.id, name === undefined ? {} : { name })
        .catch((error: unknown) => { throw providerError("snapshot", error); });
      const deadline = Date.now() + this.options.snapshotTimeoutMs;
      while (snapshot.status.state !== "Ready") {
        if (snapshot.status.state === "Failed") throw new Error("OpenSandbox snapshot failed");
        if (Date.now() >= deadline) throw new Error("OpenSandbox snapshot did not become ready in time");
        await new Promise(resolve => setTimeout(resolve, this.options.snapshotPollMs));
        snapshot = await manager.getSnapshot(snapshot.id)
          .catch((error: unknown) => { throw providerError("snapshot", error); });
      }
      return {
        provider: "opensandbox", checkpointId: snapshot.id, sourceRuntimeId: this.id,
        kind: "filesystem", scope: "portable",
      };
    } finally { await manager.close(); }
  }

  async setEnvVars(env: Record<string, string>): Promise<void> { Object.assign(this.env, env); }
  registerCommandSecrets(prefix: string, values: Record<string, string>): void { this.secrets.push({ prefix, values }); }
  commandEnv(command: string, env?: Record<string, string | undefined>): Record<string, string> {
    const result = { ...this.env };
    for (const item of this.secrets) if (command.startsWith(item.prefix)) Object.assign(result, item.values);
    for (const [key, value] of Object.entries(env ?? {})) if (value !== undefined) result[key] = value;
    return result;
  }

  async run(command: string, timeout = 120_000, background = false): Promise<CommandExecution> {
    const execution = await this.call(() => this.client.commands.run(command, {
      workingDirectory: "/workspace", background, envs: this.commandEnv(command),
      ...(background ? {} : { timeoutSeconds: timeout / 1000 }),
    }, undefined, AbortSignal.timeout(timeout + 30_000)));
    // Nonzero exits can finish with an SDK error and exitCode, without a
    // separate execution_complete event. An empty/truncated stream is neither.
    if (!execution.complete && !execution.error) throw new Error("OpenSandbox command stream ended before execution_complete");
    return execution;
  }
  async exec(command: string, timeout?: number): Promise<string> {
    const result = await this.run(command, timeout);
    const stdout = result.logs.stdout.map((message) => message.text).join("");
    const stderr = result.logs.stderr.map((message) => message.text).join("");
    const exitCode = result.exitCode ?? 0;
    if (result.error && !exitCode) throw new Error("OpenSandbox command failed to execute");
    const combined = (stdout + (stderr ? `${stdout && !stdout.endsWith("\n") ? "\n" : ""}${stderr}` : "")).trimEnd();
    return combined + (exitCode ? `\n[exit ${exitCode}]` : "");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return this.call(() => this.client.files.readBytes(normalise(path)));
  }
  async readFile(path: string): Promise<string> { return Buffer.from(await this.readFileBytes(path)).toString("utf8"); }
  async writeFile(path: string, content: string): Promise<string> { return this.writeFileBytes(path, Buffer.from(content)); }
  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const target = normalise(path);
    await this.call(() => this.client.files.createDirectories([{ path: target.slice(0, target.lastIndexOf("/")) || "/", mode: 755 }]));
    await this.call(() => this.client.files.writeFiles([{ path: target, data: bytes, mode: 644 }]));
    return target;
  }
  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec) {
    return spawnBridge(this, spec, randomInt(45000, 65000));
  }
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    try { await this.client.kill(); }
    catch (error) { if (statusCode(error) !== 404) throw providerError("request", error); }
    await this.client.close();
    this.destroyed = true;
  }
}

function normalise(path: string): string { return path.startsWith("/") ? path : `/workspace/${path}`; }

async function allocate(
  ctx: Parameters<SandboxProviderPort["create"]>[0], env: SandboxFactoryEnv, snapshotId?: string,
): Promise<OpenSandbox> {
  const options = optionsFromEnvironment(env);
  const sdk = await loadSdk();
  const operation = snapshotId === undefined ? "create" : "restore";
  let client: SdkSandbox;
  try {
    client = await sdk.Sandbox.create({
      connectionConfig: configuration(sdk, options),
      // The server treats image and snapshotId as mutually exclusive.
      ...(snapshotId === undefined ? { image: options.image } : { snapshotId }),
      timeoutSeconds: options.timeoutSeconds,
      resource: { cpu: options.cpu, memory: options.memory },
      entrypoint: ["tail", "-f", "/dev/null"], metadata: { "oma-session-id": ctx.sessionId },
      readyTimeoutSeconds: options.readyTimeoutMs / 1000,
      signal: AbortSignal.timeout(options.readyTimeoutMs),
    });
  } catch (error) { throw providerError(operation, error); }
  const sandbox = new OpenSandbox(client, options);
  try {
    await client.files.createDirectories([{ path: "/workspace", mode: 755 }]);
    return sandbox;
  } catch (error) {
    await sandbox.destroy().catch(() => undefined);
    throw providerError("request", error);
  }
}

export const sandboxProvider: SandboxProviderPort<OpenSandbox> = {
  create: (ctx, env) => allocate(ctx, env),
  async resume(handle, _ctx, env) {
    if (handle.provider !== "opensandbox" || !handle.runtimeId) throw new Error("Incompatible OpenSandbox runtime handle");
    const options = optionsFromEnvironment(env);
    const sdk = await loadSdk();
    const manager = sdk.SandboxManager.create({ connectionConfig: configuration(sdk, options) });
    let state: string;
    try { state = (await manager.getSandboxInfo(handle.runtimeId)).status.state.toLowerCase(); }
    catch (error) { throw providerError("resume", error); }
    finally { await manager.close(); }
    if (["terminated", "failed", "deleted", "error"].includes(state)) throw new Error("OpenSandbox runtime is stopped; cannot attach");
    let client: SdkSandbox | undefined;
    try {
      const connect = {
        sandboxId: handle.runtimeId, connectionConfig: configuration(sdk, options),
        readyTimeoutSeconds: options.readyTimeoutMs / 1000, signal: AbortSignal.timeout(options.readyTimeoutMs),
      };
      // A retained runtime suspended by this adapter is resumed in place.
      client = state === "paused" ? await sdk.Sandbox.resume(connect) : await sdk.Sandbox.connect(connect);
      if (state === "paused") await client.renew(options.timeoutSeconds);
      await client.files.createDirectories([{ path: "/workspace", mode: 755 }]);
    } catch (error) {
      await client?.close();
      throw providerError("resume", error);
    }
    return new OpenSandbox(client, options);
  },
  async restore(checkpoint, ctx, env) {
    if (checkpoint.provider !== "opensandbox" || checkpoint.scope !== "portable"
      || checkpoint.kind !== "filesystem" || !checkpoint.checkpointId) {
      throw new Error("OpenSandbox provider received an incompatible portable checkpoint");
    }
    return allocate(ctx, env, checkpoint.checkpointId);
  },
};
export const sandboxFactory: SandboxFactory = (ctx, env) => sandboxProvider.create(ctx, env);
