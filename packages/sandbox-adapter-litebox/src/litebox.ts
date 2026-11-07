// BoxLite (aka Litebox) implementation of SandboxExecutor.
//
// BoxLite (https://github.com/boxlite-ai/boxlite, npm: @boxlite-ai/boxlite)
// is a local-first micro-VM sandbox — each box gets its own kernel via
// Firecracker. Hardware-level isolation, no daemon required, ships a
// Rust core with a Node.js binding. The selling point vs LocalSubprocess:
// real isolation against `rm -rf /` from a prompt-injected agent without
// needing the operator to run docker.
//
// Driver dep is a peer with peerDependenciesMeta.optional — caller installs:
//   pnpm add @boxlite-ai/boxlite
//
// SDK shape (as of @boxlite-ai/boxlite ^0.8):
//   const box = new SimpleBox({ image, env, volumes, ... })
//   await box.exec("sh", ["-c", command], env, { timeoutSecs })
//   await box.copyIn(hostPath, containerPath)
//   await box.copyOut(containerPath, hostPath)
//   await box.stop()
//
// Lazy-create: BoxLite's box is created on first exec(), so any
// configuration that needs to land BEFORE creation (volumes, image, env)
// must be collected via setEnvVars / mountMemoryStore / ctor opts before
// the first exec/readFile/writeFile call. We track this via `created` —
// once true, mutating ops that affect ctor opts throw.

import type { ProcessHandle, SandboxExecutor, SandboxFactory, SandboxFactoryContext, SandboxFactoryEnv, SandboxRuntimeHandle } from "@open-managed-agents/sandbox";
import { promises as fs, mkdirSync } from "node:fs";
import { dirname, join, resolve, posix } from "node:path";
import { tmpdir, hostname, homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { getLogger } from "@open-managed-agents/observability";
import { rejectPreparedBase } from "@open-managed-agents/sandbox";

const moduleLogger = getLogger("litebox-sandbox");

export interface LiteBoxSandboxOptions {
  /** Container image. Default: `node:22-bookworm` (includes git for Managed repository resources). */
  image?: string;
  /** Optional VM resource limits. */
  memoryMib?: number;
  cpus?: number;
  /** Default per-call timeout (ms). */
  defaultTimeoutMs?: number;
  /** Logger for debug/warn output. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
  /** Optional name (must be unique). */
  name?: string;
  /** Memory blob root on the host — used by mountMemoryStore for the
   *  per-storeId source dir. Falls back to `process.env.MEMORY_BLOB_DIR`
   *  when omitted (back-compat for prior deploys). */
  memoryRoot?: string;
  /** Per-session outputs root on the host — used by mountSessionOutputs.
   *  Falls back to `process.env.FILES_BLOB_DIR` when omitted. */
  outputsRoot?: string;
  /** Host-owned lifecycle root for copy staging. The factory binds this to
   *  the session workdir so crash leftovers are reaped with the session. */
  scratchRoot?: string;
  /** Explicit durable runtime home. Only the factory uses the native retained
   * resource path; direct construction keeps pre-create native mount staging. */
  runtimeHome?: string;
  existingHandle?: SandboxRuntimeHandle;
}

interface LiteBoxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
interface LiteBoxInstance {
  exec(
    cmd: string,
    args: string[],
    env?: Record<string, string>,
    options?: { cwd?: string; user?: string; timeoutSecs?: number },
  ): Promise<LiteBoxExecResult>;
  copyIn(hostPath: string, containerDest: string, options?: unknown): Promise<void>;
  copyOut(containerSrc: string, hostDest: string, options?: unknown): Promise<void>;
  stop(): Promise<void>;
}

interface NativeLiteBox {
  readonly id: string;
  readonly name: string | null;
  exec(command: string, args: string[], env: Array<[string, string]>, tty: boolean,
    user?: string, timeoutSecs?: number, cwd?: string): Promise<{
      stdout(): Promise<{ next(): Promise<string | null> }>;
      stderr(): Promise<{ next(): Promise<string | null> }>;
      wait(): Promise<{ exitCode: number; errorMessage?: string }>;
    }>;
  copyIn(hostPath: string, guestPath: string, options?: unknown): Promise<void>;
  copyOut(guestPath: string, hostPath: string, options?: unknown): Promise<void>;
}
interface NativeLiteBoxRuntime {
  create(options: Record<string, unknown>, name?: string): Promise<NativeLiteBox>;
  get(id: string): Promise<NativeLiteBox | null>;
  remove(id: string, force: boolean): Promise<void>;
}
type NativeRuntimeConstructor = new (options: { homeDir: string }) => NativeLiteBoxRuntime;
// Client cache only. Resume always calls the runtime's authoritative get(id).
const nativeRuntimes = new WeakMap<NativeRuntimeConstructor, Map<string, NativeLiteBoxRuntime>>();
function nativeRuntime(ctor: NativeRuntimeConstructor, home: string): NativeLiteBoxRuntime {
  let homes = nativeRuntimes.get(ctor);
  if (!homes) { homes = new Map(); nativeRuntimes.set(ctor, homes); }
  let runtime = homes.get(home);
  if (!runtime) { runtime = new ctor({ homeDir: home }); homes.set(home, runtime); }
  return runtime;
}

/** Adapt the SDK's public native contracts, without replacing SimpleBox's
 * protected fields or using getOrCreate as a reconnect operation. */
class BoundLiteBox implements LiteBoxInstance {
  constructor(private readonly box: NativeLiteBox, private readonly runtime: NativeLiteBoxRuntime) {}
  async exec(command: string, args: string[], env: Record<string, string> = {}, options: { cwd?: string; user?: string; timeoutSecs?: number } = {}): Promise<LiteBoxExecResult> {
    const execution = await this.box.exec(command, args, Object.entries(env), false, options.user, options.timeoutSecs, options.cwd);
    const collect = async (stream: { next(): Promise<string | null> }) => {
      let output = "";
      for (;;) { const chunk = await stream.next(); if (chunk === null) return output; output += chunk; }
    };
    const [stdout, stderr, result] = await Promise.all([
      execution.stdout().then(collect), execution.stderr().then(collect), execution.wait(),
    ]);
    if (result.errorMessage) throw new Error(result.errorMessage);
    return { stdout, stderr, exitCode: result.exitCode };
  }
  copyIn(hostPath: string, guestPath: string, options?: unknown) { return this.box.copyIn(hostPath, guestPath, options); }
  copyOut(guestPath: string, hostPath: string, options?: unknown) { return this.box.copyOut(guestPath, hostPath, options); }
  async stop(): Promise<void> {
    await this.runtime.remove(this.box.id, true);
    if (await this.runtime.get(this.box.id) !== null) throw new Error("LiteBox removal was not confirmed");
  }
}

export class LiteBoxSandbox implements SandboxExecutor {
  private envVars: Record<string, string> = {};
  private commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  private volumes: Array<{ hostPath: string; guestPath: string; readOnly?: boolean }> = [];
  private boxPromise: Promise<LiteBoxInstance> | null = null;
  private logger: NonNullable<LiteBoxSandboxOptions["logger"]>;
  private tmpRoot: string;
  private handle: SandboxRuntimeHandle | null = null;
  private destroyed = false;

  constructor(private opts: LiteBoxSandboxOptions = {}) {
    this.logger = opts.logger ?? {
      warn: (msg) => moduleLogger.warn({}, msg),
      log: (msg) => moduleLogger.info(msg),
    };
    // Per-instance host scratch dir for copyIn / copyOut staging. Cleaned
    // up on destroy.
    this.tmpRoot = opts.scratchRoot
      ? join(resolve(opts.scratchRoot), ".openma", `litebox-scratch-${Buffer.from(randomBytes(6)).toString("hex")}`)
      : join(tmpdir(), `oma-litebox-${Buffer.from(randomBytes(6)).toString("hex")}`);
    mkdirSync(this.tmpRoot, { recursive: true });
  }

  async initializeBinding(): Promise<void> {
    try { await this.ensureBox(); }
    catch (failure) { await removeBestEffort(this.tmpRoot, true); throw failure; }
  }
  runtimeHandle(): SandboxRuntimeHandle {
    if (!this.handle) throw new Error("LiteBox has not been allocated by its durable factory");
    return { ...this.handle, metadata: { ...this.handle.metadata } };
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const box = await this.ensureBox();
    const env = this.buildEnv(command);
    const timeoutMs = timeout ?? this.opts.defaultTimeoutMs ?? 120_000;
    // Transport failures do not establish whether the remote command ran.
    const r = await box.exec("sh", ["-c", command], env, {
      cwd: "/workspace",
      timeoutSecs: Math.max(1, Math.ceil(timeoutMs / 1000)),
    });
    if (!Number.isSafeInteger(r.exitCode)) throw new Error("LiteBox command completion was not confirmed", { cause: r });
    const separator = r.stdout.length > 0 && !r.stdout.endsWith("\n") ? "\n" : "";
    return (r.stdout + (r.stderr ? `${separator}${r.stderr}` : "")).replace(/\s+$/, "") +
      (r.exitCode !== 0 ? `\n[exit ${r.exitCode}]` : "");
  }

  async startProcess(_command: string): Promise<ProcessHandle | null> {
    // BoxLite's exec is blocking; backgrounding would need a separate API
    // (and a ProcessHandle bookkeeping pass). Returning null keeps the
    // harness's startProcess callers correct — they fall back to exec
    // with a longer timeout.
    return null;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.push({ prefix: commandPrefix, secrets });
  }

  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    if (this.boxPromise) {
      throw new Error(
        "LiteBoxSandbox.mountMemoryStore: box already created — mounts must " +
        "be configured before the first exec/readFile/writeFile call",
      );
    }
    const memoryRoot = this.opts.memoryRoot
      ? resolve(this.opts.memoryRoot)
      : process.env.MEMORY_BLOB_DIR
        ? resolve(process.env.MEMORY_BLOB_DIR)
        : null;
    if (!memoryRoot) {
      throw new Error(
        "LiteBoxSandbox.mountMemoryStore: memoryRoot not provided (constructor) " +
        "and MEMORY_BLOB_DIR env var not set — set one of them so mounts can " +
        "find the on-disk content",
      );
    }
    if (!this.opts.memoryRoot && process.env.MEMORY_BLOB_DIR) {
      this.logger.warn(
        "LiteBoxSandbox.mountMemoryStore falling back to MEMORY_BLOB_DIR env var; " +
        "wire ctx.memoryRoot through SandboxFactoryContext to remove the warning",
      );
    }
    const hostPath = join(memoryRoot, opts.storeId);
    mkdirSync(hostPath, { recursive: true });
    const guestPath = `/mnt/memory/${opts.storeName}`;
    this.volumes.push({ hostPath, guestPath, readOnly: opts.readOnly });
  }

  sessionOutputMountCapabilities(): { durability: "durable" } | null {
    if (this.opts.runtimeHome !== undefined) {
      return this.volumes.some(volume => volume.guestPath === "/mnt/session/outputs")
        ? { durability: "durable" } : null;
    }
    return this.opts.outputsRoot || process.env.FILES_BLOB_DIR
      ? { durability: "durable" }
      : null;
  }

  async mountSessionOutputs(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    const outputsRoot = this.opts.outputsRoot
      ? resolve(this.opts.outputsRoot)
      : process.env.FILES_BLOB_DIR
        ? resolve(process.env.FILES_BLOB_DIR)
        : null;
    if (!outputsRoot) {
      throw new Error(
        "LiteBoxSandbox.mountSessionOutputs: outputsRoot not provided (constructor) " +
        "and FILES_BLOB_DIR env var not set — set one of them so mounts have " +
        "a host directory to bind",
      );
    }
    const hostPath = join(outputsRoot, opts.tenantId, opts.sessionId);
    const mounted = this.volumes.find(volume => volume.guestPath === "/mnt/session/outputs");
    // The durable factory stages this mount before creating/getting the box.
    // The orchestrator can repeat the same declaration after binding; it may
    // never retarget a retained VM's immutable host volume.
    if (mounted?.hostPath === hostPath) return;
    if (this.boxPromise) {
      throw new Error(
        "LiteBoxSandbox.mountSessionOutputs: box already created — mounts must " +
        "be configured before the first exec/readFile/writeFile call",
      );
    }
    if (mounted) throw new Error("LiteBox Session output mount is already configured for another directory");
    if (!this.opts.outputsRoot && process.env.FILES_BLOB_DIR) {
      this.logger.warn(
        "LiteBoxSandbox.mountSessionOutputs falling back to FILES_BLOB_DIR env var; " +
        "wire ctx.outputsRoot through SandboxFactoryContext to remove the warning",
      );
    }
    mkdirSync(hostPath, { recursive: true });
    this.volumes.push({ hostPath, guestPath: "/mnt/session/outputs", readOnly: false });
  }

  async readFile(path: string): Promise<string> {
    return Buffer.from(await this.readFileBytes(path)).toString("utf8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const box = await this.ensureBox();
    const target = this.normalise(path);
    // SDK copyOut reads the rootfs outside the container mount namespace.
    // Mounted files must be read by a command inside the VM, never by following
    // untrusted guest symlinks directly from the host process.
    if (this.isMountedPath(target)) {
      const result = await box.exec("base64", ["--", target]);
      if (result.exitCode !== 0) throw new Error(`LiteBox mounted read failed: ${result.stderr}`);
      const encoded = result.stdout.replace(/\s/g, "");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) throw new Error("LiteBox mounted read returned invalid base64");
      return bytes;
    }
    const tmp = join(this.tmpRoot, `read-${Buffer.from(randomBytes(6)).toString("hex")}`);
    try {
      await box.copyOut(target, tmp);
      const buf = await fs.readFile(tmp);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (cause) {
      throw new Error(`LiteBox read failed for ${target}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    } finally {
      await removeBestEffort(tmp);
    }
  }

  async writeFile(path: string, content: string): Promise<string> {
    const box = await this.ensureBox();
    const tmp = join(this.tmpRoot, `write-${Buffer.from(randomBytes(6)).toString("hex")}`);
    const target = this.normalise(path);
    await fs.writeFile(tmp, content, "utf8");
    try {
      await this.copyIntoBox(box, tmp, target);
    } finally {
      await removeBestEffort(tmp);
    }
    return target;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const box = await this.ensureBox();
    const tmp = join(this.tmpRoot, `write-${Buffer.from(randomBytes(6)).toString("hex")}`);
    const target = this.normalise(path);
    await fs.writeFile(tmp, bytes);
    try {
      await this.copyIntoBox(box, tmp, target);
    } finally {
      await removeBestEffort(tmp);
    }
    return target;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.boxPromise) {
      try {
        const box = await this.boxPromise;
        await box.stop();
        if (this.opts.runtimeHome !== undefined) this.destroyed = true;
        else this.boxPromise = null;
      } catch (err) {
        this.logger.warn(`destroy stop failed: ${(err as Error).message}`);
        throw err;
      }
    }
    await removeBestEffort(this.tmpRoot, true);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async ensureBox(): Promise<LiteBoxInstance> {
    if (this.destroyed) throw new Error("LiteBox has been deleted");
    if (this.boxPromise) return this.boxPromise;
    this.boxPromise = (async () => {
      type LiteBoxModule = {
        JsBoxlite: NativeRuntimeConstructor;
        SimpleBox: new (options: {
          image?: string;
          memoryMib?: number;
          cpus?: number;
          name?: string;
          volumes?: Array<{ hostPath: string; guestPath: string; readOnly?: boolean }>;
          network?: { mode: "enabled" | "disabled"; allowNet?: string[] };
        }) => LiteBoxInstance;
      };
      const mod = (await import(
        /* @vite-ignore */ "@boxlite-ai/boxlite" as string,
      ).catch((err) => {
        throw new Error(
          `LiteBoxSandbox: failed to load '@boxlite-ai/boxlite' — ` +
          `pnpm add @boxlite-ai/boxlite (cause: ${String(err)})`,
        );
      })) as LiteBoxModule;
      if (this.opts.runtimeHome !== undefined) {
        const runtime = nativeRuntime(mod.JsBoxlite, this.opts.runtimeHome);
        const existing = this.opts.existingHandle;
        const outputsHostPath = this.volumes.find(volume => volume.guestPath === "/mnt/session/outputs")?.hostPath ?? null;
        if (existing && (existing.metadata?.outputsHostPath ?? null) !== outputsHostPath) {
          throw new Error("LiteBox handle does not match the configured Session output mount");
        }
        const box = existing
          ? await runtime.get(existing.runtimeId)
          : await runtime.create({ image: this.opts.image ?? "node:22-bookworm", memoryMib: this.opts.memoryMib,
            cpus: this.opts.cpus, autoRemove: false, detach: true, volumes: this.volumes, network: { mode: "enabled" } }, this.opts.name);
        if (!box) throw new Error("LiteBox resource no longer exists");
        if (!box.id || box.name !== this.opts.name || (existing && box.id !== existing.runtimeId)) {
          throw new Error("LiteBox handle does not match its physical Session allocation");
        }
        this.handle = { provider: "litebox", runtimeId: box.id,
          metadata: { host: hostname(), runtimeHome: this.opts.runtimeHome, allocationName: this.opts.name ?? null, outputsHostPath } };
        const bound = new BoundLiteBox(box, runtime);
        if (!existing) {
          const workspace = await bound.exec("mkdir", ["-p", "/workspace"]);
          if (workspace.exitCode !== 0) throw new Error("LiteBox could not initialize /workspace");
        }
        return bound;
      }
      this.logger.log(`creating box (image=${this.opts.image ?? "node:22-bookworm"})`);
      const box = new mod.SimpleBox({
        image: this.opts.image ?? "node:22-bookworm",
        memoryMib: this.opts.memoryMib,
        cpus: this.opts.cpus,
        name: this.opts.name,
        volumes: this.volumes,
        network: { mode: "enabled" },
      });
      const workspace = await box.exec("mkdir", ["-p", "/workspace"]);
      if (workspace.exitCode !== 0) {
        throw new Error(
          `LiteBoxSandbox could not initialize /workspace: ${workspace.stderr || workspace.stdout}`,
        );
      }
      return box;
    })();
    return this.boxPromise;
  }

  /**
   * /workspace/foo → /workspace/foo (BoxLite has no opinion on workdir
   * by default; the harness assumes /workspace exists). We don't rewrite
   * paths the way LocalSubprocess does because BoxLite IS isolated, and
   * /workspace is just a regular dir inside the VM's rootfs.
   */
  private normalise(p: string): string {
    if (p.startsWith("/")) return p;
    return `/workspace/${p}`;
  }

  private isMountedPath(path: string): boolean {
    const normalized = posix.normalize(path);
    return this.volumes.some(({ guestPath }) => normalized === guestPath || normalized.startsWith(`${guestPath}/`));
  }

  private buildEnv(command: string): Record<string, string> {
    const out: Record<string, string> = { ...this.envVars };
    for (const { prefix, secrets } of this.commandSecrets) {
      if (command.startsWith(prefix)) Object.assign(out, secrets);
    }
    return out;
  }

  private async copyIntoBox(
    box: LiteBoxInstance,
    hostPath: string,
    target: string,
  ): Promise<void> {
    const prepared = await box.exec("mkdir", ["-p", dirname(target)]);
    if (prepared.exitCode !== 0) {
      throw new Error(
        `LiteBoxSandbox could not create ${dirname(target)}: ${prepared.stderr || prepared.stdout}`,
      );
    }
    if (!this.isMountedPath(target)) {
      await box.copyIn(hostPath, target);
      return;
    }
    // copyIn also bypasses mounts. Stage outside them, then copy inside the
    // guest namespace. Use argv, not a shell string, for user-controlled paths.
    const staging = `/var/tmp/openma-litebox-copy-${Buffer.from(randomBytes(12)).toString("hex")}`;
    try {
      await box.copyIn(hostPath, staging);
      const copied = await box.exec("cp", ["--", staging, target]);
      if (copied.exitCode !== 0) throw new Error(`LiteBox mounted write failed: ${copied.stderr}`);
    } finally {
      // A cleanup error must not replace an uncertain copy's primary failure.
      await box.exec("rm", ["-f", "--", staging]).catch(() => undefined);
    }
  }
}

async function removeBestEffort(path: string, recursive = false): Promise<void> {
  try {
    await fs.rm(path, { recursive, force: true });
  } catch {
    // Scratch cleanup must never mask the sandbox operation's outcome.
  }
}

// ── Factory (DIP entry point) ───────────────────────────────────────

function factoryOptions(ctx: SandboxFactoryContext, env: SandboxFactoryEnv): LiteBoxSandboxOptions {
  rejectPreparedBase("litebox", ctx.preparedBase);
  return {
    // An Environment-selected catalog image overrides the process default.
    image: ctx.image?.reference ?? env.SANDBOX_IMAGE,
    memoryMib: env.LITEBOX_MEMORY_MIB ? Number(env.LITEBOX_MEMORY_MIB) : undefined,
    cpus: env.LITEBOX_CPUS ? Number(env.LITEBOX_CPUS) : undefined,
    name: ctx.allocationId === undefined ? `oma-${ctx.sessionId}`
      : `oma-${createHash("sha256").update(JSON.stringify([ctx.workspaceId, ctx.environmentId, ctx.sessionId, ctx.allocationId])).digest("hex").slice(0, 30)}`,
    memoryRoot: ctx.memoryRoot,
    outputsRoot: ctx.outputsRoot,
    scratchRoot: ctx.workdir,
    runtimeHome: resolve(env.LITEBOX_HOME ?? join(homedir(), ".boxlite")),
  };
}

async function bindSandbox(ctx: SandboxFactoryContext, options: LiteBoxSandboxOptions): Promise<LiteBoxSandbox> {
  const sandbox = new LiteBoxSandbox(options);
  if (ctx.workspaceId !== undefined && (options.outputsRoot || process.env.FILES_BLOB_DIR)) {
    await sandbox.mountSessionOutputs({ tenantId: ctx.workspaceId, sessionId: ctx.sessionId });
  }
  await sandbox.initializeBinding();
  return sandbox;
}

/** Durable factory uses retained native boxes and file-synced memory. The
 * Session output host volume is staged before allocation and verified on resume. */
export const sandboxFactory: SandboxFactory = Object.assign(async (ctx: SandboxFactoryContext, env: SandboxFactoryEnv) => {
  return bindSandbox(ctx, factoryOptions(ctx, env));
}, {
  capabilities: { allocationIsolation: true },
  runtimeBinding: {
    provider: "litebox", scope: "host" as const,
    getHandle: (sandbox: SandboxExecutor) => (sandbox as LiteBoxSandbox).runtimeHandle(),
    async resume(handle: SandboxRuntimeHandle, ctx: SandboxFactoryContext, env: SandboxFactoryEnv) {
      const options = factoryOptions(ctx, env);
      if (handle.provider !== "litebox" || !handle.runtimeId || handle.metadata?.host !== hostname()
        || handle.metadata?.runtimeHome !== options.runtimeHome || handle.metadata?.allocationName !== options.name) {
        throw new Error("LiteBox handle does not match this host, runtime home or Session allocation");
      }
      return bindSandbox(ctx, { ...options, existingHandle: handle });
    },
  },
});
