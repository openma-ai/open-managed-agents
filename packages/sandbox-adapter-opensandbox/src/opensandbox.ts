// OpenMA ports backed by the official OpenSandbox SDK. Provider credentials
// stay in the control-plane connection config, never in the sandbox environment.
import { randomInt } from "node:crypto";
import { Buffer } from "node:buffer";
import type { CommandExecution, Sandbox as SdkSandbox, Volume } from "@alibaba-group/opensandbox";
import type {
  SandboxCheckpointHandle, SandboxCheckpointKind, SandboxDuplexProcessPort, SandboxDuplexProcessSpec,
  SandboxFactory, SandboxFactoryEnv, SandboxPort, SandboxProviderPort,
  SandboxRuntimeHandle, SandboxRuntimePort, SandboxRuntimeStatus,
} from "@open-managed-agents/sandbox";
import { DEFAULT_WORKSPACE_ROOT, PLATFORM_ROOT, workspaceRootFromProbe } from "@open-managed-agents/sandbox";
import { spawnBridge } from "./stdio-bridge";

export interface OpenSandboxOptions {
  domain: string;
  protocol: "http" | "https";
  apiKey?: string;
  image: string;
  runtime?: string;
  templateId?: string;
  timeoutSeconds: number;
  readyTimeoutMs: number;
  cpu: string;
  memory: string;
  snapshotTimeoutMs: number;
  snapshotPollMs: number;
  /** What a pause retains on the declared backend; memory only when the operator declares it. */
  suspendKind: "filesystem" | "memory";
  volumes: Volume[];
}

/** Backends whose pause retains memory and processes (Docker freeze; Fast Sandbox vmstate per docs). */
const MEMORY_RUNTIMES = new Set(["docker", "fast"]);

function suspendKindFrom(env: SandboxFactoryEnv): "filesystem" | "memory" {
  const runtime = env.OPENSANDBOX_RUNTIME;
  if (runtime !== undefined && !["docker", "kubernetes", "fast"].includes(runtime)) {
    throw new Error("OPENSANDBOX_RUNTIME must be docker, kubernetes or fast");
  }
  const kind = env.OPENSANDBOX_SUSPEND_KIND;
  if (kind !== undefined && kind !== "filesystem" && kind !== "memory") {
    throw new Error("OPENSANDBOX_SUSPEND_KIND must be filesystem or memory");
  }
  if (kind === "memory" && (runtime === undefined || !MEMORY_RUNTIMES.has(runtime))) {
    throw new Error("OPENSANDBOX_SUSPEND_KIND=memory requires OPENSANDBOX_RUNTIME=docker or fast");
  }
  return kind ?? (runtime !== undefined && MEMORY_RUNTIMES.has(runtime) ? "memory" : "filesystem");
}

/** Parses OPENSANDBOX_VOLUMES (SDK Volume[] JSON). Errors never echo the value: ossfs entries carry keys. */
export function volumesFromEnvironment(env: SandboxFactoryEnv): Volume[] {
  const raw = env.OPENSANDBOX_VOLUMES;
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("OPENSANDBOX_VOLUMES must be a JSON array of OpenSandbox volumes"); }
  if (!Array.isArray(parsed)) throw new Error("OPENSANDBOX_VOLUMES must be a JSON array of OpenSandbox volumes");
  const names = new Set<string>();
  return parsed.map((value, index) => {
    const volume = value as Volume;
    const where = `OPENSANDBOX_VOLUMES[${index}]`;
    if (typeof volume !== "object" || volume === null || typeof volume.name !== "string" || !volume.name) throw new Error(`${where} needs a name`);
    if (names.has(volume.name)) throw new Error(`${where} duplicates volume name`);
    names.add(volume.name);
    if (typeof volume.mountPath !== "string" || !volume.mountPath.startsWith("/")) throw new Error(`${where} needs an absolute mountPath`);
    if ([volume.host, volume.pvc, volume.ossfs].filter(b => b != null).length !== 1) throw new Error(`${where} must set exactly one of host, pvc, ossfs`);
    if (volume.host && typeof volume.host.path !== "string") throw new Error(`${where}.host needs path`);
    if (volume.pvc && typeof volume.pvc.claimName !== "string") throw new Error(`${where}.pvc needs claimName`);
    if (volume.ossfs && (typeof volume.ossfs.bucket !== "string" || typeof volume.ossfs.endpoint !== "string"
      || typeof volume.ossfs.accessKeyId !== "string" || typeof volume.ossfs.accessKeySecret !== "string")) {
      throw new Error(`${where}.ossfs needs bucket, endpoint, accessKeyId and accessKeySecret`);
    }
    return volume;
  });
}

/** Stable, credential-free identity of a volume: backend location + subPath + mountPath. */
export function openSandboxVolumeIdentity(volume: Volume): string {
  const sub = volume.subPath ? `/${volume.subPath.replace(/^\/+/, "")}` : "";
  const source = volume.pvc ? `pvc://${volume.pvc.claimName}`
    : volume.ossfs ? `ossfs://${volume.ossfs.bucket}@${volume.ossfs.endpoint}`
    : volume.host ? `host://${volume.host.path}` : "unknown://";
  return `opensandbox:${source}${sub}#${volume.mountPath}`;
}

/**
 * Builds a managed-runtime `durableMount` for a volume mounted at `mountPath`
 * by OPENSANDBOX_VOLUMES. Volumes are fixed at Sandbox.create, so attach only
 * verifies the acquired runtime was created with the same volume identity.
 */
/** OpenSandbox validates metadata like Kubernetes label values (<=63 chars,
 * alphanumeric at both ends, then [A-Za-z0-9_.-]); Session ids may end in
 * `_` or `-`. The label is informational only, so it is normalised rather
 * than letting an unlucky id fail sandbox creation. */
export function sessionLabel(sessionId: string): Record<string, string> {
  const value = sessionId.replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 63).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "");
  return value === "" ? {} : { "oma-session-id": value };
}

export function openSandboxDurableMount(env: SandboxFactoryEnv, mountPath: string) {
  const volume = volumesFromEnvironment(env).find(v => v.mountPath === mountPath);
  if (volume === undefined) throw new Error(`OPENSANDBOX_VOLUMES has no volume mounted at ${mountPath}`);
  const identity = openSandboxVolumeIdentity(volume);
  return {
    identity: () => identity,
    async attach({ runtime, signal }: { runtime: object; signal: AbortSignal }) {
      signal.throwIfAborted();
      const identities = (runtime as { volumeIdentities?(): string[] }).volumeIdentities?.();
      if (!identities?.includes(identity)) throw new Error(`OpenSandbox runtime is missing durable volume at ${mountPath}`);
    },
  };
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
  const suspendKind = suspendKindFrom(env);
  const templateId = env.OPENSANDBOX_TEMPLATE_ID?.trim();
  if (templateId !== undefined && !templateId) throw new Error("OPENSANDBOX_TEMPLATE_ID must not be empty");
  if (templateId !== undefined && env.OPENSANDBOX_RUNTIME !== "fast") {
    throw new Error("OPENSANDBOX_TEMPLATE_ID requires OPENSANDBOX_RUNTIME=fast");
  }
  const volumes = volumesFromEnvironment(env);
  if (env.OPENSANDBOX_RUNTIME === "fast" && volumes.length) {
    throw new Error("Fast Sandbox does not support OPENSANDBOX_VOLUMES");
  }
  return {
    domain, protocol,
    apiKey: env.OPENSANDBOX_API_KEY ?? env.OPEN_SANDBOX_API_KEY,
    image: env.SANDBOX_IMAGE ?? "node:22-slim",
    runtime: env.OPENSANDBOX_RUNTIME,
    templateId,
    timeoutSeconds: positive(env.OPENSANDBOX_TIMEOUT_SECONDS, 1800, "OPENSANDBOX_TIMEOUT_SECONDS", 60),
    readyTimeoutMs: positive(env.OPENSANDBOX_READY_TIMEOUT_MS, 120_000, "OPENSANDBOX_READY_TIMEOUT_MS"),
    cpu: env.OPENSANDBOX_CPU ?? "1",
    memory: env.OPENSANDBOX_MEMORY ?? "1Gi",
    snapshotTimeoutMs: positive(env.OPENSANDBOX_SNAPSHOT_TIMEOUT_MS, 600_000, "OPENSANDBOX_SNAPSHOT_TIMEOUT_MS"),
    snapshotPollMs: positive(env.OPENSANDBOX_SNAPSHOT_POLL_MS, 1_000, "OPENSANDBOX_SNAPSHOT_POLL_MS"),
    suspendKind,
    volumes,
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

  constructor(
    private client: SdkSandbox,
    private readonly options: OpenSandboxOptions,
    /** The image's WORKDIR, or /workspace when it declares none (ADR 0016). */
    readonly workspaceRoot: string = DEFAULT_WORKSPACE_ROOT,
  ) {
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
  // Pause semantics differ by backend: Docker freezes the container (memory and
  // processes kept), Kubernetes commits rootfs only. Memory is advertised only
  // when the operator declares a backend that retains it. Portable snapshots
  // preserve files; Fast Sandbox also restores guest memory and processes.
  runtimeCapabilities() {
    const suspend = this.options.suspendKind === "memory" ? ["filesystem", "memory"] as const : ["filesystem"] as const;
    return { lease: true, suspend, checkpoint: ["filesystem"] as const };
  }
  volumeIdentities(): string[] { return this.options.volumes.map(openSandboxVolumeIdentity); }
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
    if (kind === "memory" && this.options.suspendKind !== "memory") {
      throw new Error("OpenSandbox memory suspend requires OPENSANDBOX_RUNTIME=docker or fast");
    }
    // Hot pause only: expires_at stays absolute while paused. Renew to the
    // normal active window so pause starts with a full one; a failed renewal
    // never leaves a doomed pause. Long-lived state belongs in volumes or snapshots.
    await this.call(() => this.client.renew(this.options.timeoutSeconds));
    await this.call(() => this.client.pause());
    const deadline = Date.now() + this.options.readyTimeoutMs;
    while (true) {
      const state = (await this.call(() => this.client.getInfo())).status.state.toLowerCase();
      if (state === "paused") break;
      if (["terminated", "failed", "deleted", "error"].includes(state)) throw new Error(`OpenSandbox pause failed (state ${state})`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("OpenSandbox pause did not complete in time");
      await new Promise(resolve => setTimeout(resolve, Math.min(500, remaining)));
    }
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
    // Fast Sandbox renewal changes the CR generation and can briefly revoke
    // route readiness. Renew first so SDK resume waits after both mutations.
    if (this.options.runtime === "fast") await this.call(() => previous.renew(this.options.timeoutSeconds));
    const resumed = await this.call(() => previous.resume({ readyTimeoutSeconds: this.options.readyTimeoutMs / 1000 }));
    this.client = resumed;
    await previous.close().catch(() => undefined);
    if (this.options.runtime !== "fast") await this.call(() => resumed.renew(this.options.timeoutSeconds));
  }
  async checkpoint({ kind, name }: { kind: SandboxCheckpointKind; name?: string }): Promise<SandboxCheckpointHandle> {
    if (kind !== "filesystem") throw new Error("OpenSandbox portable checkpoints require kind filesystem");
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
      if (this.options.runtime === "fast") {
        // The artifact can become Ready before the source route has recovered.
        await this.call(() => this.client.waitUntilReady({ readyTimeoutSeconds: this.options.readyTimeoutMs / 1000, pollingIntervalMillis: 500 }));
      }
      return {
        provider: "opensandbox", checkpointId: snapshot.id, sourceRuntimeId: this.id,
        kind: "filesystem", scope: "portable",
      };
    } finally { await manager.close(); }
  }

  async resolveWorkspaceRoot(): Promise<string> { return this.workspaceRoot; }
  /** Relative paths resolve against the workspace root, like `exec`. */
  resolvePath(path: string): string { return path.startsWith("/") ? path : `${this.workspaceRoot}/${path}`; }
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
      workingDirectory: this.workspaceRoot, background, envs: this.commandEnv(command),
      ...(background ? {} : { timeoutSeconds: timeout / 1000 }),
    }, undefined, AbortSignal.timeout(timeout + 30_000)));
    // Nonzero exits can finish with an SDK error and exitCode, without a
    // separate execution_complete event. An empty/truncated stream is neither.
    if (!execution.complete && !execution.error) throw new Error("OpenSandbox command stream ended before execution_complete");
    return execution;
  }
  async exec(command: string, timeout?: number): Promise<string> {
    const result = await this.run(command, timeout);
    const stdout = joinOutputLines(result.logs.stdout);
    const stderr = joinOutputLines(result.logs.stderr);
    const exitCode = result.exitCode ?? 0;
    if (result.error && !exitCode) throw new Error("OpenSandbox command failed to execute");
    const combined = (stdout + (stderr ? `${stdout && !stdout.endsWith("\n") ? "\n" : ""}${stderr}` : "")).trimEnd();
    return combined + (exitCode ? `\n[exit ${exitCode}]` : "");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return this.call(() => this.client.files.readBytes(this.resolvePath(path)));
  }
  async readFile(path: string): Promise<string> { return Buffer.from(await this.readFileBytes(path)).toString("utf8"); }
  async writeFile(path: string, content: string): Promise<string> { return this.writeFileBytes(path, Buffer.from(content)); }
  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const target = this.resolvePath(path);
    await this.call(() => this.client.files.createDirectories([{ path: target.slice(0, target.lastIndexOf("/")) || "/", mode: 755 }]));
    await this.call(() => this.client.files.writeFiles([{ path: target, data: bytes, mode: 644 }]));
    return target;
  }
  /** Writes owner-only files (dir 0700, files 0600) for data that must stay off argv. */
  async writePrivateFiles(dir: string, files: Record<string, Uint8Array>): Promise<void> {
    const target = this.resolvePath(dir);
    await this.call(() => this.client.files.createDirectories([{ path: target, mode: 700 }]));
    await this.call(() => this.client.files.writeFiles(Object.entries(files).map(([name, data]) => ({ path: `${target}/${name}`, data, mode: 600 }))));
  }
  async removeDirectory(dir: string): Promise<void> {
    await this.call(() => this.client.files.deleteDirectories([this.resolvePath(dir)]));
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

/**
 * execd frames command output one line per message with the line break
 * removed, and reports an empty line as a lone "\n". Rebuild the text with
 * the line breaks restored; a message that still carries its own trailing
 * break is accepted too.
 */
export function joinOutputLines(messages: ReadonlyArray<{ text: string }>): string {
  return messages
    .map(({ text }) => text === "\n" ? "" : text.endsWith("\n") ? text.slice(0, -1) : text)
    .join("\n");
}

/**
 * Resolve the workspace root (ADR 0016): a command without an explicit cwd
 * runs in the image's WORKDIR. Then make sure it and the platform root exist.
 */
async function prepareWorkspace(client: SdkSandbox): Promise<string> {
  const probe = await client.commands.run("pwd", {});
  if (!probe.complete || probe.exitCode) throw new Error("OpenSandbox could not resolve the working directory");
  const workspaceRoot = workspaceRootFromProbe(joinOutputLines(probe.logs.stdout));
  await client.files.createDirectories([
    { path: workspaceRoot, mode: 755 },
    { path: PLATFORM_ROOT, mode: 755 },
  ]);
  return workspaceRoot;
}

async function allocate(
  ctx: Parameters<SandboxProviderPort["create"]>[0], env: SandboxFactoryEnv, snapshotId?: string,
): Promise<OpenSandbox> {
  const options = optionsFromEnvironment(env);
  if (options.runtime === "fast" && snapshotId === undefined && !options.templateId) {
    throw new Error("OPENSANDBOX_RUNTIME=fast requires OPENSANDBOX_TEMPLATE_ID for creation");
  }
  // A catalog image selected by the Environment overrides SANDBOX_IMAGE. Fast
  // Sandbox creates from its template only, so it must refuse rather than
  // silently run the template instead of the selected image.
  if (ctx.image !== undefined && options.runtime === "fast" && snapshotId === undefined) {
    throw new Error("OPENSANDBOX_RUNTIME=fast cannot honour a per-environment sandbox image");
  }
  const image = ctx.image?.reference ?? options.image;
  const sdk = await loadSdk();
  const operation = snapshotId === undefined ? "create" : "restore";
  let client: SdkSandbox;
  try {
    const common = {
      connectionConfig: configuration(sdk, options),
      timeoutSeconds: options.timeoutSeconds,
      metadata: sessionLabel(ctx.sessionId),
      readyTimeoutSeconds: options.readyTimeoutMs / 1000,
      signal: AbortSignal.timeout(options.readyTimeoutMs),
    };
    client = options.runtime === "fast" && snapshotId === undefined
      ? await sdk.Sandbox.createFromTemplate({ ...common, templateId: options.templateId! })
      : await sdk.Sandbox.create({
        ...common,
        // The server treats image and snapshotId as mutually exclusive.
        ...(snapshotId === undefined ? { image } : { snapshotId }),
        // An empty resource map prevents the SDK's container defaults from
        // overriding the fixed Fast Sandbox pool profile during restore.
        resource: options.runtime === "fast" ? {} : { cpu: options.cpu, memory: options.memory },
        ...(options.volumes.length ? { volumes: options.volumes } : {}),
        entrypoint: ["tail", "-f", "/dev/null"],
      });
  } catch (error) { throw providerError(operation, error); }
  let sandbox = new OpenSandbox(client, options);
  try {
    sandbox = new OpenSandbox(client, options, await prepareWorkspace(client));
    return sandbox;
  } catch (error) {
    await sandbox.destroy().catch(() => undefined);
    throw error instanceof Error && error.message.startsWith("Sandbox reported") ? error : providerError("request", error);
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
    try {
      state = (await manager.getSandboxInfo(handle.runtimeId)).status.state.toLowerCase();
      if (state === "paused" && options.runtime === "fast") await manager.renewSandbox(handle.runtimeId, options.timeoutSeconds);
    }
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
      if (state === "paused" && options.runtime !== "fast") await client.renew(options.timeoutSeconds);
      const workspaceRoot = await prepareWorkspace(client);
      return new OpenSandbox(client, options, workspaceRoot);
    } catch (error) {
      await client?.close();
      throw error instanceof Error && error.message.startsWith("Sandbox reported") ? error : providerError("resume", error);
    }
  },
  async restore(checkpoint, ctx, env) {
    if (checkpoint.provider !== "opensandbox" || checkpoint.scope !== "portable"
      || checkpoint.kind !== "filesystem" || !checkpoint.checkpointId) {
      throw new Error("OpenSandbox provider received an incompatible portable checkpoint");
    }
    return allocate(ctx, env, checkpoint.checkpointId);
  },
};
// Every create owns a fresh provider ID; resume and destroy use captured IDs.
export const sandboxFactory: SandboxFactory = Object.assign((
  ctx: Parameters<SandboxFactory>[0], env: Parameters<SandboxFactory>[1],
) => sandboxProvider.create(ctx, env), { capabilities: { allocationIsolation: true } });
