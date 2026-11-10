// E2B (e2b.dev) implementation of SandboxPort.
//
// Lazy-imports the `e2b` SDK so this package compiles without it. The
// driver dep lives in your deployment's package.json:
//   pnpm add e2b -w   # or wherever you build the Node entry
//
// Production path for self-host: each session becomes a Firecracker microVM
// spun up via E2B's API. Boot time ~250ms cold from a warm pool, sub-200MB
// memory, full filesystem, network access controlled by the template image.
//
// Mapping to SandboxPort:
//   exec(cmd)              → sandbox.commands.run(cmd) (sync mode, capture stdout/stderr/exitCode)
//   startProcess(cmd)      → sandbox.commands.run(cmd, { background: true })
//   readFile / writeFile   → sandbox.files.read / write
//   destroy()              → sandbox.kill()
//
// Auth: pass apiKey at construction. If unset, the SDK reads E2B_API_KEY
// from process.env.

import type {
  ProcessHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxCheckpointHandle,
  SandboxFactory,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxPort,
  SandboxProviderPort,
  SandboxRuntimeCapabilities,
  SandboxRuntimeHandle,
  SandboxRuntimePort,
  SandboxRuntimeStatus,
} from "@open-managed-agents/sandbox";
import { readS3MemoryBucket, type SandboxManagedProcessSpec, type SandboxManagedProcessHandle, type SandboxManagedProcessPort } from "@open-managed-agents/sandbox";
import { startE2BManagedProcess, inspectE2BManagedSlot, restoreE2BManagedProcess, type E2BManagedIdentity, type E2BManagedLocator, type E2BManagedBootstrapOptions } from "./managed-bootstrap";

// Structural types so this file compiles without `e2b` installed. The
// driver shape is matched at runtime; mismatches surface as adapter
// errors rather than module-load errors.
interface E2BCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
interface E2BCommandHandle {
  pid: number;
  kill(): Promise<boolean | void>;
  wait?(): Promise<E2BCommandResult>;
  sendStdin?(data: string | Uint8Array): Promise<void>;
  closeStdin?(): Promise<void>;
}
interface E2BCommandOptions {
  timeoutMs?: number;
  background?: boolean;
  cwd?: string;
  envs?: Record<string, string>;
  onStdout?: (data: string) => void | Promise<void>;
  onStderr?: (data: string) => void | Promise<void>;
  stdin?: boolean;
  user?: string;
}
export interface E2BSandboxLike {
  sandboxId?: string;
  commands: {
    run(
      cmd: string,
      opts?: E2BCommandOptions,
    ): Promise<E2BCommandResult | E2BCommandHandle>;
  };
  files: {
    read(path: string, opts?: { user?: string }): Promise<string>;
    write(path: string, data: string | Uint8Array, opts?: { user?: string }): Promise<unknown>;
    makeDir?(path: string): Promise<void>;
  };
  kill(): Promise<unknown>;
  /** Atomic replacement of the sandbox egress rules. */
  updateNetwork?(network: { allowOut?: string[]; denyOut?: string[] }): Promise<void>;
  getInfo?(): Promise<{ state?: string }>;
  setTimeout?(timeoutMs: number): Promise<void>;
  pause?(opts?: { keepMemory?: boolean }): Promise<boolean>;
  connect?(): Promise<E2BSandboxLike>;
  createSnapshot?(opts?: { name?: string; mode?: "full" | "filesystem" }): Promise<{
    snapshotId: string;
    names: string[];
  }>;
}

export interface E2BSandboxOptions {
  /** Opt-in trusted template-native launcher; never uses SDK shell launch. */
  managedBootstrap?: E2BManagedBootstrapOptions;
  /** Probe the new sandbox with a no-op command before returning it. Some
   * E2B-compatible providers (Haven) briefly reject envd calls right after
   * create, e.g. `[unauthenticated] invalid username: 'user'`. Only such
   * transient errors are retried; `false` disables the probe. */
  readiness?: false | { attempts?: number; delayMs?: number };
  /** E2B API key. Falls back to process.env.E2B_API_KEY. */
  apiKey?: string;
  /** E2B-compatible control-plane URL. Falls back to E2B_API_URL. */
  apiUrl?: string;
  /** Optional sandbox traffic URL. Falls back to E2B_SANDBOX_URL. */
  sandboxUrl?: string;
  /** Optional E2B-compatible base domain. Falls back to E2B_DOMAIN. */
  domain?: string;
  /** Metadata passed only when creating a sandbox. */
  createMetadata?: Record<string, string>;
  /**
   * Template id (the `template` field in E2B's UI). Default "base" matches
   * the SDK's default — has python/node/git/curl etc preinstalled. Override
   * with a custom template per `environment.sandbox_template` config when
   * an agent needs additional packages.
   *
   * For mountMemoryStore to work, the template MUST have `s3fs` installed:
   *   Template().fromImage("ubuntu:latest").aptInstall(["s3fs"])
   */
  templateId?: string;
  /** Default per-command timeout in ms. */
  defaultTimeoutMs?: number;
  /** Sandbox user for commands and file operations. Defaults to the SDK's
   * default user. */
  user?: string;
  /**
   * Initial sandbox lifetime in ms (E2B's sandbox `timeoutMs`). Hosts extend
   * it through `renewLease` while a turn runs (OpenMA's sandbox heartbeat).
   * Defaults to 30 minutes; without it E2B gives a sandbox 5 minutes.
   */
  lifetimeMs?: number;
  /** Logger for debug output. */
  logger?: { warn: (msg: string, ctx?: unknown) => void };
  /**
   * S3-compatible bucket holding memory store content. Required only if
   * mountMemoryStore() will be called. Mirrors what apps/agent's
   * CloudflareSandbox reads from MEMORY_BUCKET_NAME / R2_ENDPOINT etc.
   * Works against R2 / Tigris / MinIO / AWS S3 — any S3 API.
   */
  memoryBucket?: {
    endpoint: string;       // e.g. https://<account>.r2.cloudflarestorage.com
    accessKey: string;
    secretKey: string;
    bucketName: string;
    /** Required for non-AWS S3 (R2 / MinIO / etc.). Defaults to true. */
    usePathRequestStyle?: boolean;
  };
}

/**
 * Build an E2BSandbox bound to a fresh remote sandbox. async because
 * the underlying Sandbox.create() is async. Caller awaits and then uses
 * the returned executor for the session lifetime.
 */
export async function createE2BSandbox(
  opts: E2BSandboxOptions = {},
  /** An already-imported SDK (Workers bundle it statically); loaded lazily otherwise. */
  module?: E2BModule,
): Promise<E2BSandboxExecutor> {
  const mod = module ?? await loadE2BModule();
  const sb = await mod.Sandbox.create(
    opts.templateId ?? "base",
    creationOptions(opts),
  );
  if (opts.readiness !== false) {
    try {
      await waitForSandboxReady(sb, opts.readiness ?? {});
    } catch (error) {
      await sb.kill?.().catch(() => undefined);
      throw error;
    }
  }
  return new E2BSandboxExecutor(sb, opts);
}

const TRANSIENT_READINESS = /\[(unauthenticated|unavailable|deadline_exceeded)\]|invalid username|connection refused|ECONNRESET|ECONNREFUSED|socket hang up|\b50[234]\b/iu;

async function waitForSandboxReady(
  sandbox: E2BSandboxLike,
  options: { attempts?: number; delayMs?: number },
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 10);
  const delayMs = Math.max(0, options.delayMs ?? 1_000);
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await sandbox.commands.run("true", { timeoutMs: 30_000 });
      return;
    } catch (error) {
      if (!TRANSIENT_READINESS.test(String((error as Error)?.message ?? error))) throw error;
      last = error;
      if (attempt < attempts && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`E2B sandbox was not ready after ${attempts} probes: ${String((last as Error)?.message ?? last)}`);
}

export class E2BSandboxExecutor
  implements SandboxPort, SandboxDuplexProcessPort, SandboxRuntimePort, SandboxManagedProcessPort {
  private managedClosed = false;
  private managedDestroyed = false;
  private readonly managedRecovery = new Set<Promise<unknown>>();
  private readonly managedStarts = new Set<Promise<SandboxManagedProcessHandle>>();
  private readonly managedBootstrap?: E2BManagedBootstrapOptions;
  private envVars: Record<string, string> = {};
  private commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  private defaultTimeoutMs: number;
  private logger: NonNullable<E2BSandboxOptions["logger"]>;
  /** Tracks whether s3fs has already mounted the memory bucket root.
   *  We mount once per sandbox lifetime; subsequent mountMemoryStore calls
   *  just symlink prefixes. */
  private memoryBucketMounted = false;
  private memoryBucketConfig?: NonNullable<E2BSandboxOptions["memoryBucket"]>;
  private readonly user: { user?: string };

  constructor(
    private sandbox: E2BSandboxLike,
    opts: E2BSandboxOptions,
  ) {
    if (opts.managedBootstrap && opts.user !== undefined && opts.user !== "oma-worker") throw new Error("Managed E2B templates require the unprivileged oma-worker user");
    this.managedBootstrap = opts.managedBootstrap;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
    this.logger = opts.logger ?? {
      warn: (msg) => console.warn(`[e2b-sandbox] ${msg}`),
    };
    this.memoryBucketConfig = opts.memoryBucket;
    this.user = opts.managedBootstrap ? { user: "oma-worker" } : opts.user === undefined ? {} : { user: opts.user };
  }

  /** Structured command result. Extra `envs` reach only this process and
   * never appear in its command line; `user` overrides the sandbox user.
   * `sessionEnv: false` leaves out the Session env set with setEnvVars (Vault
   * placeholders, the egress relay's proxy and CA variables): platform
   * commands such as storage mounts must not run through the agent's relay. */
  async run(
    command: string,
    opts: { envs?: Record<string, string>; timeoutMs?: number; user?: string; sessionEnv?: false } = {},
  ): Promise<E2BCommandResult> {
    return runCommand(this.sandbox, command, {
      timeoutMs: opts.timeoutMs ?? this.defaultTimeoutMs,
      envs: { ...(opts.sessionEnv === false ? {} : this.buildCommandEnv(command)), ...opts.envs },
      ...(opts.user === undefined ? this.user : { user: opts.user }),
    });
  }

  /** Binary-safe read; `null` when the file does not exist. */
  async readBytes(path: string): Promise<Uint8Array | null> {
    const files = this.sandbox.files as unknown as {
      read(path: string, opts: { format: "bytes"; user?: string }): Promise<Uint8Array>;
    };
    try {
      return await files.read(path, { format: "bytes", ...this.user });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "FileNotFoundError" || name === "NotFoundError") return null;
      throw error;
    }
  }

  async updateNetwork(network: { allowOut: string[]; denyOut: string[] }): Promise<void> {
    if (typeof this.sandbox.updateNetwork !== "function") {
      throw new Error("E2B SDK does not expose sandbox.updateNetwork");
    }
    await this.sandbox.updateNetwork(network);
  }

  runtimeHandle(): SandboxRuntimeHandle {
    return { provider: "e2b", runtimeId: this.requireRuntimeId() };
  }

  runtimeCapabilities(): SandboxRuntimeCapabilities {
    return {
      lease: true,
      suspend: ["filesystem", "memory"],
      checkpoint: ["memory"],
    };
  }

  async status(): Promise<SandboxRuntimeStatus> {
    if (typeof this.sandbox.getInfo !== "function") return "unknown";
    const info = await this.sandbox.getInfo();
    if (info.state === "running") return "running";
    if (info.state === "paused") return "suspended";
    return "unknown";
  }

  async renewLease(input: { ttlMs: number }): Promise<void> {
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("E2B lease ttlMs must be a positive integer");
    }
    if (typeof this.sandbox.setTimeout !== "function") {
      throw new Error("E2B SDK does not expose sandbox.setTimeout");
    }
    await this.sandbox.setTimeout(input.ttlMs);
  }

  async suspend(input: {
    kind: "filesystem" | "memory";
  }): Promise<SandboxCheckpointHandle> {
    if (typeof this.sandbox.pause !== "function") {
      throw new Error("E2B SDK does not expose sandbox.pause");
    }
    const runtimeId = this.requireRuntimeId();
    await this.sandbox.pause({ keepMemory: input.kind === "memory" });
    return {
      provider: "e2b",
      checkpointId: runtimeId,
      sourceRuntimeId: runtimeId,
      kind: input.kind,
      scope: "runtime",
    };
  }

  async resume(checkpoint: SandboxCheckpointHandle): Promise<void> {
    const runtimeId = this.requireRuntimeId();
    if (
      checkpoint.provider !== "e2b"
      || checkpoint.scope !== "runtime"
      || checkpoint.checkpointId !== runtimeId
    ) {
      throw new Error("E2B runtime can only resume its own runtime-scoped checkpoint");
    }
    if (typeof this.sandbox.connect !== "function") {
      throw new Error("E2B SDK does not expose sandbox.connect");
    }
    this.sandbox = await this.sandbox.connect();
  }

  async checkpoint(input: {
    kind: "filesystem" | "memory";
    name?: string;
  }): Promise<SandboxCheckpointHandle> {
    if (typeof this.sandbox.createSnapshot !== "function") {
      throw new Error("E2B SDK does not expose sandbox.createSnapshot");
    }
    const runtimeId = this.requireRuntimeId();
    // memory: the SDK default (full); filesystem: disk only, the sandbox
    // started from it cold-boots.
    const opts = { ...(input.name ? { name: input.name } : {}), ...(input.kind === "filesystem" ? { mode: "filesystem" as const } : {}) };
    const snapshot = await this.sandbox.createSnapshot(Object.keys(opts).length === 0 ? undefined : opts);
    return {
      provider: "e2b",
      checkpointId: snapshot.snapshotId,
      sourceRuntimeId: runtimeId,
      kind: input.kind,
      scope: "portable",
    };
  }

  /** Snapshot this sandbox's filesystem only (`mode: "filesystem"`) as a
   * reusable creation source: sandboxes created from it boot from the disk,
   * without this sandbox's memory or processes. Reusing a name appends a new
   * build under it; the returned snapshot id pins this exact build. A project
   * without filesystem-only snapshots gets E2B's 400
   * `snapshot_filesystem_only_disabled`; it is surfaced, never retried as a
   * full (memory) snapshot. */
  async snapshotEnvironment(input: { name: string }): Promise<string> {
    if (typeof this.sandbox.createSnapshot !== "function") {
      throw new Error("E2B SDK does not expose sandbox.createSnapshot");
    }
    const snapshot = await this.sandbox.createSnapshot({ name: input.name, mode: "filesystem" });
    if (!snapshot.snapshotId) {
      throw new Error("E2B SDK did not return a snapshotId for the environment snapshot");
    }
    return snapshot.snapshotId;
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const wrapped = this.applyEnv(command);
    const result = await runCommand(this.sandbox, wrapped, {
      cwd: "/workspace",
      timeoutMs: timeout ?? this.defaultTimeoutMs,
      ...this.user,
    });
    // Match @cloudflare/sandbox's behaviour: combined stdout+stderr,
    // newline-trimmed, plus an exit-code suffix.
    const separator = result.stdout.length > 0 && !result.stdout.endsWith("\n") ? "\n" : "";
    const combined =
      (result.stdout + (result.stderr ? `${separator}${result.stderr}` : "")).replace(/\s+$/, "") +
      (result.exitCode !== 0 ? `\n[exit ${result.exitCode}]` : "");
    return combined;
  }

  async startManagedProcess(spec: SandboxManagedProcessSpec, identity?: E2BManagedIdentity): Promise<SandboxManagedProcessHandle> {
    if (this.managedClosed) throw new Error("E2B management launcher is closed");
    if (!this.managedBootstrap) throw new Error("Trusted E2B management template is required");
    const starting = startE2BManagedProcess(this.sandbox, this.managedBootstrap, spec, identity);
    this.managedStarts.add(starting);
    try {
      const handle = await starting;
      if (this.managedDestroyed) throw new Error("E2B management launcher is closed");
      return handle;
    }
    catch (error) {
      // A failed acknowledgement may hide a dispatched launch. Fail closed until destroy.
      if ((error as { outcome?: string }).outcome === "unknown") this.managedClosed = true;
      throw error;
    } finally { this.managedStarts.delete(starting); }
  }

  private async recoverManaged<T>(operation: () => Promise<T>): Promise<T> {
    if (this.managedDestroyed) throw new Error("E2B management launcher is closed");
    const pending = operation();
    this.managedRecovery.add(pending);
    try {
      const value = await pending;
      if (this.managedDestroyed) throw new Error("E2B management launcher is closed");
      return value;
    } finally { this.managedRecovery.delete(pending); }
  }

  async inspectManagedProcessSlot(): Promise<E2BManagedLocator> {
    if (this.managedDestroyed) throw new Error("E2B management launcher is closed");
    if (!this.managedBootstrap) throw new Error("Trusted E2B management template is required");
    return this.recoverManaged(() => inspectE2BManagedSlot(this.sandbox, this.managedBootstrap!));
  }

  async restoreManagedProcess(locator: E2BManagedLocator): Promise<SandboxManagedProcessHandle> {
    if (this.managedDestroyed) throw new Error("E2B management launcher is closed");
    if (!this.managedBootstrap) throw new Error("Trusted E2B management template is required");
    return this.recoverManaged(() => restoreE2BManagedProcess(this.sandbox, this.managedBootstrap!, locator));
  }

  async startProcess(command: string): Promise<ProcessHandle | null> {
    const wrapped = this.applyEnv(command);
    const handle = (await this.sandbox.commands.run(wrapped, {
      background: true,
      ...this.user,
    })) as E2BCommandHandle;
    if (!handle.pid) return null;
    const id = `proc_${handle.pid}_${Date.now()}`;
    return new E2BProcessHandle(id, handle);
  }

  async spawnDuplexProcess(
    spec: SandboxDuplexProcessSpec,
  ): Promise<SandboxDuplexProcess> {
    for (const name of Object.keys(spec.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new TypeError(`Invalid environment variable name: ${JSON.stringify(name)}`);
      }
    }
    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    let stderrController!: ReadableStreamDefaultController<Uint8Array>;
    let streamsSettled = false;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) { stdoutController = controller; },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) { stderrController = controller; },
    });
    const encoder = new TextEncoder();
    const settleStreams = (error?: Error) => {
      if (streamsSettled) return;
      streamsSettled = true;
      for (const controller of [stdoutController, stderrController]) {
        try {
          if (error) controller.error(error);
          else controller.close();
        } catch {
          // The corresponding consumer may already have cancelled its stream.
        }
      }
    };
    const enqueue = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      data: string,
    ) => {
      if (streamsSettled || data.length === 0) return;
      try {
        controller.enqueue(encoder.encode(data));
      } catch {
        // The corresponding consumer may already have cancelled its stream.
      }
    };

    const unset = Object.entries(spec.env ?? {})
      .filter(([, value]) => value === undefined)
      .flatMap(([name]) => ["-u", name]);
    // Omitting an envs entry does not remove envd/image-inherited values.
    // env -u implements the duplex Port's explicit-undefined contract remotely.
    const command = [...(unset.length ? ["env", ...unset, "--"] : []), spec.command, ...(spec.args ?? [])]
      .map(shellEscape)
      .join(" ");
    const handle = (await this.sandbox.commands.run(command, {
      background: true,
      stdin: true,
      // E2B otherwise closes the process event stream after 60 seconds.
      // ConnectRPC treats a non-positive timeout as no deadline.
      timeoutMs: 0,
      cwd: spec.cwd,
      envs: this.buildCommandEnv(spec.command, spec.env),
      ...this.user,
      onStdout: (data) => enqueue(stdoutController, data),
      onStderr: (data) => enqueue(stderrController, data),
    })) as E2BCommandHandle;
    if (
      typeof handle.wait !== "function"
      || typeof handle.sendStdin !== "function"
      || typeof handle.closeStdin !== "function"
    ) {
      await handle.kill().catch(() => undefined);
      settleStreams();
      throw new Error(
        "E2B SDK does not expose the live-stdin CommandHandle required by ACP",
      );
    }

    let requestedSignal: "SIGTERM" | "SIGKILL" | null = null;
    let exitedSettled = false;
    // A broken wait transport settles the observation, not the remote process.
    let exitConfirmed = false;
    let resolveExited!: (
      value: { code: number | null; signal: string | null },
    ) => void;
    let rejectExited!: (error: Error) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => { resolveExited = resolve; rejectExited = reject; },
    );
    void exited.catch(() => undefined);
    const finish = (code: number | null, signal: string | null, error?: Error) => {
      settleStreams(error);
      if (exitedSettled) return;
      exitedSettled = true;
      if (error) rejectExited(error);
      else {
        exitConfirmed = true;
        resolveExited({ code, signal });
      }
    };
    void handle.wait().then(
      (result) => finish(result.exitCode, requestedSignal),
      (cause: unknown) => {
        const exitCode = readExitCode(cause);
        if (exitCode !== null) {
          finish(exitCode, requestedSignal);
          return;
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        finish(null, null, error);
      },
    );

    const stdin = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (exitedSettled) throw new Error("cannot write to an exited E2B process");
        await handle.sendStdin!(chunk);
      },
      close: async () => {
        if (!exitedSettled) await handle.closeStdin!();
      },
      abort: async () => {
        if (exitConfirmed) return;
        requestedSignal = "SIGKILL";
        await handle.kill();
        // Only wait() confirms exit; kill's acknowledgement is not a barrier.
      },
    });

    return {
      stdin,
      stdout,
      stderr,
      exited,
      kill: async (signal = "SIGTERM") => {
        if (exitConfirmed) return;
        // E2B v2 currently exposes SIGKILL only. Preserve the caller's
        // requested signal in the portable lifecycle result.
        requestedSignal = signal;
        await handle.kill();
        // Only wait() confirms exit; kill's acknowledgement is not a barrier.
      },
    };
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.push({ prefix: commandPrefix, secrets });
  }

  async readFile(path: string): Promise<string> {
    return this.user.user === undefined ? this.sandbox.files.read(path) : this.sandbox.files.read(path, this.user);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    // E2B's files.read returns string (UTF-8). Use a base64 shell helper
    // for binary safety — same workaround the CF SessionDO uses.
    const out = await this.exec(
      `base64 -w0 -- '${path.replace(/'/g, "'\\''")}'`,
      30_000,
    );
    if (out.includes("[exit ")) {
      throw new Error(`E2B readFileBytes failed: ${out.slice(0, 200)}`);
    }
    const b64 = out.trim();
    const bin = Buffer.from(b64, "base64");
    return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  }

  async writeFile(path: string, content: string): Promise<string> {
    if (this.user.user === undefined) await this.sandbox.files.write(path, content);
    else await this.sandbox.files.write(path, content, this.user);
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    if (this.user.user === undefined) await this.sandbox.files.write(path, bytes);
    else await this.sandbox.files.write(path, bytes, this.user);
    return path;
  }

  /**
   * Mount a memory store into the sandbox at /mnt/memory/<storeName>/.
   *
   * Strategy: s3fs mounts the WHOLE bucket once at /mnt/_oma_storage on the
   * first call; per-store mounts are then symlinks from that mount under
   * the store-id prefix. This avoids one s3fs process per store (hundreds
   * of stores per session would exhaust file descriptors otherwise).
   *
   * Requires:
   *   1. The E2B template has `s3fs` installed (apt-get install s3fs)
   *   2. memoryBucket: { endpoint, accessKey, secretKey, bucketName } was
   *      passed at sandbox construction
   *
   * Read-only enforcement: PoC limitation — symlinks don't enforce ro.
   * Future work: bind-mount with `-o ro` for read-only stores. Today
   * read-only is honoured at the application layer (memory tools refuse
   * write ops on stores the agent has read-only access to).
   */
  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    const cfg = this.memoryBucketConfig;
    if (!cfg) {
      throw new Error(
        "mountMemoryStore: E2BSandbox constructed without memoryBucket config — " +
          "pass { memoryBucket: { endpoint, accessKey, secretKey, bucketName } } to createE2BSandbox",
      );
    }

    if (!this.memoryBucketMounted) {
      // First call: write s3fs credentials and mount the bucket root.
      await this.sandbox.files.write(
        "/root/.passwd-s3fs",
        `${cfg.accessKey}:${cfg.secretKey}\n`,
      );
      await this.runOrThrow("sudo chmod 600 /root/.passwd-s3fs");
      await this.runOrThrow("sudo mkdir -p /mnt/_oma_storage");
      const flags = [
        `-o url=${shellEscape(cfg.endpoint)}`,
        cfg.usePathRequestStyle === false ? "" : "-o use_path_request_style",
        // allow_other so the unprivileged sandbox user can read; nonempty
        // so we can re-mount over an existing dir without errors.
        "-o allow_other",
        "-o nonempty",
        "-o uid=1000",
        "-o gid=1000",
      ]
        .filter(Boolean)
        .join(" ");
      await this.runOrThrow(
        `sudo s3fs ${shellEscape(cfg.bucketName)} /mnt/_oma_storage ${flags}`,
      );
      this.memoryBucketMounted = true;
      this.logger.warn(
        `mountMemoryStore: bucket ${cfg.bucketName} mounted at /mnt/_oma_storage`,
      );
    }

    // Per-store: ensure the mount-point dir + symlink the prefix.
    const mountPoint = `/mnt/memory/${opts.storeName}`;
    const sourcePath = `/mnt/_oma_storage/${opts.storeId}`;
    await this.runOrThrow(`sudo mkdir -p /mnt/memory && sudo rm -rf ${shellEscape(mountPoint)}`);
    await this.runOrThrow(`sudo ln -sfn ${shellEscape(sourcePath)} ${shellEscape(mountPoint)}`);
    if (opts.readOnly) {
      // Best-effort chmod -w; s3fs respects FUSE-level read-only via
      // a remount which the sandbox SDK doesn't expose. Document the
      // residual gap in docs/self-host.md.
      await this.runOrThrow(
        `sudo chmod -R a-w ${shellEscape(sourcePath)} 2>/dev/null || true`,
      );
    }
  }

  sessionOutputMountCapabilities(): { durability: "durable" } | null {
    return this.memoryBucketConfig === undefined
      ? null
      : { durability: "durable" };
  }

  async mountSessionOutputs(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    // Reuses the same s3fs bucket as memory under a session-scoped prefix.
    const cfg = this.memoryBucketConfig;
    if (!cfg) {
      throw new Error(
        "E2BSandbox.mountSessionOutputs: no memoryBucket config — sessions " +
        "outputs share the bucket with memory under session-outputs/<tenant>/<session>/",
      );
    }
    if (!this.memoryBucketMounted) {
      // mountMemoryStore handles mount-once; reuse via a no-op store
      // mount when the caller hasn't asked for any.
      await this.mountMemoryStore({
        storeName: "_outputs_bootstrap",
        storeId: "_outputs_bootstrap",
        readOnly: true,
      });
    }
    const mountPoint = `/mnt/session/outputs`;
    const sourcePath = `/mnt/_oma_storage/session-outputs/${opts.tenantId}/${opts.sessionId}`;
    await this.runOrThrow(
      `sudo mkdir -p /mnt/session && sudo rm -rf ${shellEscape(mountPoint)}`,
    );
    await this.runOrThrow(
      `sudo ln -sfn ${shellEscape(sourcePath)} ${shellEscape(mountPoint)}`,
    );
  }

  /** Run a command, throw with combined output on non-zero exit. Used for
   *  setup commands where silent failure (e.g. s3fs mount issues) would
   *  leave the agent staring at an empty mount-point with no clue why. */
  private async runOrThrow(command: string): Promise<void> {
    const out = await this.exec(command, 30_000);
    if (out.includes("[exit ")) {
      throw new Error(`E2BSandbox setup command failed: ${command}\n  → ${out}`);
    }
  }

  async destroy(): Promise<void> {
    this.managedDestroyed = true;
    this.managedClosed = true;
    await Promise.allSettled([...this.managedStarts, ...this.managedRecovery]);
    try {
      await this.sandbox.kill();
    } catch (err) {
      if (this.managedBootstrap) throw err;
      this.logger.warn(`destroy failed: ${(err as Error).message}`);
    }
  }

  private requireRuntimeId(): string {
    if (!this.sandbox.sandboxId) {
      throw new Error("E2B SDK did not return a sandboxId");
    }
    return this.sandbox.sandboxId;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** Prefix env-var assignments and command-prefix secrets for the legacy
   * string-command paths. Duplex processes use E2B v2's native `envs` field. */
  private applyEnv(command: string): string {
    const env = this.buildCommandEnv(command);
    if (Object.keys(env).length === 0) return command;
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${shellEscape(v)};`)
      .join(" ");
    return `${exports} ${command}`;
  }

  private buildCommandEnv(
    command: string,
    overrides: Record<string, string | undefined> = {},
  ): Record<string, string> {
    const env: Record<string, string> = { ...this.envVars };
    for (const { prefix, secrets } of this.commandSecrets) {
      if (command.startsWith(prefix)) Object.assign(env, secrets);
    }
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    return env;
  }
}

/** Split start from wait: the SDK uses the SAME error types in both stages.
 * A PID-bearing handle proves dispatch even if its stream failed immediately. */
async function runCommand(sandbox: E2BSandboxLike, command: string, options: E2BCommandOptions): Promise<E2BCommandResult> {
  let started = false;
  try {
    const result = await settleCommand(sandbox.commands.run(command, { ...options, background: true }) as Promise<E2BCommandResult>);
    if ("exitCode" in result && typeof result.exitCode === "number") return result;
    started = true;
    const handle = result as unknown as E2BCommandHandle;
    if (!handle.pid || handle.wait === undefined) throw new Error("SDK supplied no waitable command handle");
    return await settleCommand(handle.wait());
  } catch (cause) {
    if (!started && isRejectedCommandStart(cause)) throw cause;
    throw Object.assign(new Error("Dispatched command outcome is unknown", { cause }), { outcome: "dispatched_unknown" });
  }
}

// Only used in the explicit start stage, never to classify wait errors.
function isRejectedCommandStart(error: unknown): boolean {
  const name = error !== null && typeof error === "object" && "name" in error ? error.name : undefined;
  return name === "AuthenticationError" || name === "InvalidArgumentError";
}

class E2BProcessHandle implements ProcessHandle {
  pid: number;
  private stdout = "";
  private stderr = "";
  private waitPromise: Promise<E2BCommandResult> | null = null;
  private finalResult: E2BCommandResult | null = null;

  constructor(public id: string, private handle: E2BCommandHandle) {
    this.pid = handle.pid;
    if (handle.wait) {
      this.waitPromise = settleCommand(handle.wait()).then((r) => {
        this.finalResult = r;
        this.stdout = r.stdout;
        this.stderr = r.stderr;
        return r;
      });
    }
  }

  async kill(signal: string): Promise<void> {
    // The E2B v2 command API only exposes SIGKILL; retain ProcessHandle's
    // portable signature while delegating to the supported primitive.
    void signal;
    try { await this.handle.kill(); } catch (err) {
      throw new Error(`kill failed: ${(err as Error).message}`);
    }
  }

  async getLogs(): Promise<{ stdout: string; stderr: string }> {
    return { stdout: this.stdout, stderr: this.stderr };
  }

  async getStatus(): Promise<string> {
    if (this.finalResult === null) return "running";
    if (this.finalResult.exitCode === 0) return "completed";
    return "error";
  }
}

function shellEscape(value: string): string {
  // Single-quote-wrap; double any embedded single quotes via the
  // ' '\'' ' idiom which is portable across POSIX shells.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The official SDK rejects a finished command with CommandExitError (which
 * implements CommandResult) whenever the exit code is non-zero. A non-zero
 * exit is an ordinary outcome for SandboxPort callers, so fold it back into a
 * result; anything else (transport, auth, timeout) stays an error.
 */
async function settleCommand(pending: Promise<E2BCommandResult>): Promise<E2BCommandResult> {
  try {
    return await pending;
  } catch (cause) {
    const exitCode = readExitCode(cause);
    if (exitCode === null) throw cause;
    const failed = cause as { stdout?: unknown; stderr?: unknown };
    return {
      exitCode,
      stdout: typeof failed.stdout === "string" ? failed.stdout : "",
      stderr: typeof failed.stderr === "string" ? failed.stderr : "",
    };
  }
}

function readExitCode(cause: unknown): number | null {
  if (
    typeof cause === "object"
    && cause !== null
    && "exitCode" in cause
    && typeof cause.exitCode === "number"
  ) {
    return cause.exitCode;
  }
  return null;
}

// ── Factory (DIP entry point) ───────────────────────────────────────

export type E2BConnectionOptions = Pick<
  E2BSandboxOptions,
  "apiKey" | "apiUrl" | "sandboxUrl" | "domain"
>;

export type E2BCreateOptions = E2BConnectionOptions & {
  metadata?: Record<string, string>;
  timeoutMs?: number;
  lifecycle: {
    onTimeout: { action: "pause"; keepMemory: true };
    autoResume: boolean;
  };
};

export interface E2BModule {
  Sandbox: {
    create(template: string, args?: E2BCreateOptions): Promise<E2BSandboxLike>;
    connect(sandboxId: string, args?: E2BConnectionOptions): Promise<E2BSandboxLike>;
  };
}

async function loadE2BModule(): Promise<E2BModule> {
  return (await import(/* @vite-ignore */ "e2b" as string).catch((err) => {
    throw new Error(
      `E2B sandbox provider failed to load 'e2b' SDK — ` +
        `pnpm add e2b (cause: ${String(err)})`,
    );
  })) as E2BModule;
}

function connectionOptions(opts: E2BConnectionOptions): E2BConnectionOptions {
  return {
    apiKey: opts.apiKey,
    apiUrl: opts.apiUrl,
    sandboxUrl: opts.sandboxUrl,
    domain: opts.domain,
  };
}

const DEFAULT_SANDBOX_LIFETIME_MS = 30 * 60_000;

const sandboxLifetime = (opts: E2BSandboxOptions): number =>
  opts.lifetimeMs !== undefined && Number.isSafeInteger(opts.lifetimeMs) && opts.lifetimeMs > 0
    ? opts.lifetimeMs
    : DEFAULT_SANDBOX_LIFETIME_MS;

function parseLifetime(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error("E2B_SANDBOX_TIMEOUT_MS must be a positive integer of milliseconds");
  }
  return ms;
}

function creationOptions(opts: E2BSandboxOptions): E2BCreateOptions {
  return {
    ...connectionOptions(opts),
    ...(opts.createMetadata === undefined ? {} : { metadata: opts.createMetadata }),
    timeoutMs: sandboxLifetime(opts),
    // ACP keeps a live JSON-RPC process in the sandbox. Killing the sandbox
    // at the end of its lease loses that process and forces a cold restore;
    // a memory pause preserves it and E2B resumes it transparently on the
    // next command or stdin write.
    lifecycle: {
      onTimeout: { action: "pause", keepMemory: true },
      autoResume: opts.managedBootstrap?.disableAutoResume !== true,
    },
  };
}

function parseCreateMetadata(value: string | undefined): Record<string, string> | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("E2B_CREATE_METADATA must be valid JSON");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || Object.values(parsed).some((item) => typeof item !== "string")
  ) {
    throw new Error("E2B_CREATE_METADATA must be a JSON object with string values");
  }
  return parsed as Record<string, string>;
}

function optionsFromFactory(
  env: SandboxFactoryEnv,
  ctx?: Pick<SandboxFactoryContext, "image">,
): E2BSandboxOptions {
  return {
    apiKey: env.E2B_API_KEY,
    apiUrl: env.E2B_API_URL,
    sandboxUrl: env.E2B_SANDBOX_URL,
    domain: env.E2B_DOMAIN,
    createMetadata: parseCreateMetadata(env.E2B_CREATE_METADATA),
    lifetimeMs: parseLifetime(env.E2B_SANDBOX_TIMEOUT_MS),
    // An Environment-selected catalog image overrides the process default.
    templateId: ctx?.image?.reference ?? env.SANDBOX_IMAGE,
    memoryBucket: readS3MemoryBucket(env),
  };
}

/** The v1 provider. `module`: the SDK a composition root that depends on
 * `e2b` itself loaded (the adapter only declares it as an optional peer, so
 * an application's own install is the one that resolves); omitted = loaded
 * lazily from this package. */
export function createE2BSandboxProvider(module?: E2BModule): SandboxProviderPort<E2BSandboxExecutor> {
  const load = () => module === undefined ? loadE2BModule() : Promise.resolve(module);
  return {
    create: async (ctx, env) => createE2BSandbox(optionsFromFactory(env, ctx), await load()),
    resume: async (handle, _ctx, env) => {
      if (handle.provider !== "e2b" || !handle.runtimeId) {
        throw new Error("E2B provider received an incompatible runtime handle");
      }
      const options = optionsFromFactory(env);
      const mod = await load();
      const sandbox = await mod.Sandbox.connect(
        handle.runtimeId,
        connectionOptions(options),
      );
      return new E2BSandboxExecutor(sandbox, options);
    },
    restore: async (checkpoint, _ctx, env) => {
      if (
        checkpoint.provider !== "e2b"
        || checkpoint.scope !== "portable"
        || !checkpoint.checkpointId
      ) {
        throw new Error("E2B provider received an incompatible portable checkpoint");
      }
      const options = optionsFromFactory(env);
      const mod = await load();
      const sandbox = await mod.Sandbox.create(
        checkpoint.checkpointId,
        creationOptions(options),
      );
      return new E2BSandboxExecutor(sandbox, options);
    },
  };
}

export const sandboxProvider: SandboxProviderPort<E2BSandboxExecutor> = createE2BSandboxProvider();

/** Each create receives a new provider-assigned id; no Session-name attach.
 * Snapshot support remains opt-in for E2B-compatible services. `module`:
 * as for createE2BSandboxProvider. */
export function createE2BSandboxFactory(module?: E2BModule): SandboxFactory {
  const provider = module === undefined ? sandboxProvider : createE2BSandboxProvider(module);
  return Object.assign((
    ctx: SandboxFactoryContext,
    env: SandboxFactoryEnv,
  ) => provider.create(ctx, env), { capabilities: { allocationIsolation: true } });
}

export const sandboxFactory: SandboxFactory = createE2BSandboxFactory();
