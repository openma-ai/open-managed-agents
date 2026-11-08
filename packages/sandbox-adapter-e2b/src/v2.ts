// Native Sandbox SDK v2 adapter for E2B (design §0.1 / §0.2). Reuses the
// v1 executor (E2BSandboxExecutor) as the runtime; the SDK module is
// injected so Workers can bundle it statically.
//
// lifecycle      handle "changes" (E2B assigns sandbox ids)
// acquire        Sandbox.create(plan.from) with {workspaceId, sessionId} metadata
// attach         Sandbox.connect (resumes a paused sandbox)
// keepAlive      setTimeout(leaseMs); leaseMs must exceed plan.idleMs
// maxLifetimeMs  required: the account plan's continuous-run cap (Hobby 1 h,
//                Pro 24 h); plan.idleMs must stay below it
// pause/resume   pause (full memory) / connect; the ref is the sandbox itself
// checkpoint     createSnapshot; resume from it = Sandbox.create(snapshotId)
// snapshotTemplate createSnapshot under a name
// release        Sandbox.kill; discard = Sandbox.deleteSnapshot
// list           Sandbox.list filtered by metadata
// storage        objectStorage given: rclone FUSE mounts for Memory and
//                outputs (native), each verified after mounting; omitted:
//                no native storage (generic sync)
// not found → "gone" / SandboxGoneError; 429 / 503 → RetryableSandboxError

import {
  RetryableSandboxError,
  SandboxGoneError,
  type Acquired,
  type ResumeRef,
  type SandboxHandle,
  type SandboxLifecyclePort,
  type SandboxPlan,
  type SandboxStoragePort,
  type TemplateRef,
} from "@open-managed-agents/sandbox";
import type { FirewallRules } from "@open-managed-agents/sandbox-port-kit/firewall";
import type { ObjectStoreCredentialPort } from "@open-managed-agents/sandbox-port-kit/object-storage";
import { SESSION_OUTPUTS_DIR } from "@open-managed-agents/sandbox-port-kit/object-storage";
import { SandboxAssemblyError, type SandboxAdapterPort, type SandboxVendorPort } from "@open-managed-agents/sandbox-port-kit/ports";
import {
  E2BSandboxExecutor,
  createE2BSandbox,
  type E2BConnectionOptions,
  type E2BCreateOptions,
  type E2BModule,
  type E2BSandboxLike,
  type E2BSandboxOptions,
} from "./e2b";

/** The parts of the `e2b` module the v2 adapter calls. */
export interface E2BV2Module extends E2BModule {
  Sandbox: E2BModule["Sandbox"] & {
    connect(sandboxId: string, args?: E2BConnectionOptions & { timeoutMs?: number }): Promise<E2BSandboxLike>;
    kill(sandboxId: string, args?: E2BConnectionOptions): Promise<boolean>;
    deleteSnapshot(snapshotId: string, args?: E2BConnectionOptions): Promise<boolean>;
    list(args?: E2BConnectionOptions & {
      query?: { metadata?: Record<string, string>; state?: Array<"running" | "paused"> };
      limit?: number;
    }): {
      hasNext: boolean;
      nextItems(): Promise<Array<{ sandboxId: string; metadata?: Record<string, string>; startedAt: Date | string }>>;
    };
  };
}

export interface E2BV2AdapterOptions {
  sdk: E2BV2Module;
  connection: E2BConnectionOptions;
  /** Provider idle reclaim (E2B timeout), renewed by keepAlive. Must exceed
   * every plan's idleMs, or E2B pauses the sandbox before the core does. */
  leaseMs: number;
  /** E2B's cap on continuous running for this account's plan (Hobby
   * 3_600_000, Pro 86_400_000; pause + resume restarts it). Required and
   * never queried from E2B: past it E2B silently truncates setTimeout and
   * pauses the sandbox (design §0.0 rule 11). Every plan's idleMs must be
   * below it. */
  maxLifetimeMs: number;
  /** Sandbox user for exec and files. Default: the SDK default user. */
  user?: string;
  /** Run as root right after a sandbox starts, before its firewall is
   * applied (for example installing s3fs). */
  setup?: string;
  /** Hosts the platform itself needs from inside the sandbox (object
   * storage, ...). Added to every allowlist. */
  channels?: string[];
  /** Native storage: rclone FUSE mounts for Memory Stores and for
   * /mnt/session/outputs, each over prefix-scoped temporary credentials
   * minted from its own bucket's parent key (a parent key only reaches its
   * own bucket). Omitted = no native storage: createSandboxPorts composes
   * createSyncStorage, which copies Memory in and out and uploads outputs at
   * turn boundaries. */
  objectStorage?: E2BObjectStorageOptions;
  /** The runtime's s3fs bucket (v1 executor mountMemoryStore /
   * mountSessionOutputs) for compositions whose own storage Port calls
   * them (the Node control plane). Omitted = those calls fail. */
  memoryBucket?: E2BSandboxOptions["memoryBucket"];
}

/** The Session scope storage calls receive (this package does not depend on
 * runtime-resource-contract directly). */
type StorageScope = Parameters<SandboxStoragePort<E2BSandboxExecutor>["attach"]>[0]["scope"];

export interface E2BObjectStorageOptions {
  /** Memory bucket: Memory Store `<storeId>/` prefixes. */
  memory: ObjectStoreCredentialPort;
  /** Files bucket: the Session outputs prefix. */
  outputs: ObjectStoreCredentialPort;
  /** Key prefix of a Session's outputs in the files bucket. */
  outputsPrefix(scope: StorageScope): string;
  /** Lifetime of each minted credential (default 1 h). A mount is re-minted
   * and remounted at the next attach or sync once less than half is left. */
  ttlSeconds?: number;
}

const SELF = "self";
const DEFAULT_RETRY_AFTER_MS = 1_000;

/** `setup` creating the platform mount points. A base template's default
 * user cannot create directories under /mnt, so the setup runs as root
 * (with `user: "root"` for every later call). */
export const E2B_SANDBOX_DIRECTORIES = "mkdir -p /workspace /mnt/session/outputs /mnt/memory";
/** `setup` for native storage: the mount points plus rclone + FUSE. */
export const E2B_SANDBOX_SETUP = [
  E2B_SANDBOX_DIRECTORIES,
  "if ! command -v rclone >/dev/null 2>&1 || ! command -v fusermount3 >/dev/null 2>&1; then",
  "  if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq rclone fuse3 >/dev/null;",
  "  elif command -v apk >/dev/null 2>&1; then apk add --no-cache rclone fuse3 >/dev/null;",
  "  else echo 'no package manager to install rclone' >&2; exit 1; fi",
  "fi",
].join("\n");

export function createE2BV2Adapter(options: E2BV2AdapterOptions): SandboxAdapterPort<E2BSandboxExecutor> {
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
    throw new TypeError("E2B leaseMs must be a positive integer");
  }
  const declared = (options as { maxLifetimeMs?: unknown }).maxLifetimeMs;
  if (typeof declared !== "number" || !Number.isSafeInteger(declared) || declared <= 0) {
    throw new SandboxAssemblyError("E2B maxLifetimeMs is required: a positive integer of milliseconds matching the account plan's continuous-run cap");
  }
  const maxLifetimeMs: number = declared;
  const { sdk, connection } = options;
  const executorOptions = {
    ...connection,
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.memoryBucket === undefined ? {} : { memoryBucket: options.memoryBucket }),
    lifetimeMs: options.leaseMs,
  };
  const handleOf = (runtime: E2BSandboxExecutor): SandboxHandle => ({ provider: "e2b", runtimeId: runtime.runtimeHandle().runtimeId });
  const requireOwn = (value: { provider: string }) => {
    if (value.provider !== "e2b") throw new Error(`E2B adapter received a ${value.provider} reference`);
  };

  async function prepare(runtime: E2BSandboxExecutor): Promise<void> {
    if (options.setup === undefined) return;
    const result = await runtime.run(options.setup, { user: "root", timeoutMs: 300_000 });
    if (result.exitCode !== 0) {
      throw new Error(`E2B sandbox setup failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 300)}`);
    }
  }

  async function start(source: string, plan: SandboxPlan, signal: AbortSignal): Promise<Acquired<E2BSandboxExecutor> | "gone"> {
    signal.throwIfAborted();
    if (plan.idleMs >= options.leaseMs) {
      throw new Error(`E2B leaseMs (${options.leaseMs}) must exceed the plan idleMs (${plan.idleMs})`);
    }
    if (plan.idleMs >= maxLifetimeMs) {
      throw new SandboxAssemblyError(`E2B maxLifetimeMs (${maxLifetimeMs}) must exceed the plan idleMs (${plan.idleMs})`);
    }
    let runtime: E2BSandboxExecutor;
    try {
      runtime = await createE2BSandbox({ ...executorOptions, templateId: source, createMetadata: { ...plan.labels } }, sdk);
    } catch (error) {
      if (isGone(error)) return "gone";
      throw mapError(error);
    }
    try {
      await prepare(runtime);
      return { runtime, handle: handleOf(runtime) };
    } catch (error) {
      await runtime.destroy();
      throw mapError(error);
    }
  }

  async function connect(runtimeId: string): Promise<Acquired<E2BSandboxExecutor> | "gone"> {
    try {
      const sandbox = await sdk.Sandbox.connect(runtimeId, { ...connection, timeoutMs: options.leaseMs });
      const runtime = new E2BSandboxExecutor(sandbox, executorOptions);
      return { runtime, handle: handleOf(runtime) };
    } catch (error) {
      if (isGone(error)) return "gone";
      throw mapError(error);
    }
  }

  const lifecycle: SandboxLifecyclePort<E2BSandboxExecutor> = {
    handle: "changes",
    maxLifetimeMs,

    async acquire(input) {
      const from = input.plan.from;
      if ("template" in from) requireOwn(from.template);
      return start("template" in from ? from.template.ref : from.image, input.plan, input.signal);
    },

    async attach(input) {
      requireOwn(input.handle);
      input.signal.throwIfAborted();
      return connect(input.handle.runtimeId);
    },

    async keepAlive(input) {
      try {
        await input.runtime.renewLease({ ttlMs: options.leaseMs });
        return "alive";
      } catch (error) {
        if (isGone(error)) return "gone";
        throw mapError(error);
      }
    },

    async checkpoint(input) {
      input.signal.throwIfAborted();
      const checkpoint = await lifecycleCall(() => input.runtime.checkpoint({ kind: "memory" }));
      return { provider: "e2b", ref: checkpoint.checkpointId, metadata: { kind: "snapshot", source: input.handle.runtimeId } };
    },

    async pause(input) {
      input.signal.throwIfAborted();
      await lifecycleCall(() => input.runtime.suspend({ kind: "memory" }));
      return { provider: "e2b", ref: input.handle.runtimeId, metadata: { kind: SELF } };
    },

    async resume(input) {
      requireOwn(input.ref);
      if (input.ref.metadata?.kind === SELF) {
        input.signal.throwIfAborted();
        return connect(input.ref.ref);
      }
      return start(input.ref.ref, input.plan, input.signal);
    },

    async release(input) {
      requireOwn(input.handle);
      try {
        await sdk.Sandbox.kill(input.handle.runtimeId, connection);
      } catch (error) {
        if (!isGone(error)) throw mapError(error);
      }
    },

    async discard(input) {
      requireOwn(input.ref);
      if (input.ref.metadata?.kind === SELF) return;
      try {
        await sdk.Sandbox.deleteSnapshot(input.ref.ref, connection);
      } catch (error) {
        if (!isGone(error)) throw mapError(error);
      }
    },

    async snapshotTemplate(input): Promise<TemplateRef> {
      input.signal.throwIfAborted();
      const base = await lifecycleCall(() => input.runtime.capturePreparedBase({ name: `oma-${input.handle.runtimeId}` }));
      return { provider: "e2b", ref: base.id };
    },

    async list(input) {
      const metadata = Object.fromEntries(Object.entries(input.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const paginator = sdk.Sandbox.list({ ...connection, query: { metadata, state: ["running", "paused"] } });
      const found: Awaited<ReturnType<SandboxLifecyclePort<E2BSandboxExecutor>["list"]>> = [];
      while (paginator.hasNext) {
        input.signal.throwIfAborted();
        let items: Awaited<ReturnType<typeof paginator.nextItems>>;
        try {
          items = await paginator.nextItems();
        } catch (error) {
          throw mapError(error);
        }
        for (const item of items) {
          const workspaceId = item.metadata?.workspaceId;
          const sessionId = item.metadata?.sessionId;
          if (workspaceId === undefined || sessionId === undefined) continue;
          found.push({
            handle: { provider: "e2b", runtimeId: item.sandboxId },
            labels: { workspaceId, sessionId },
            createdAt: new Date(item.startedAt).toISOString(),
          });
        }
      }
      return found;
    },
  };

  const vendor: SandboxVendorPort<E2BSandboxExecutor> = {
    /** Runs in /workspace, the logical root the generic implementations
     * address relative paths from (the relay installer's .oma-egress). */
    async exec(runtime, cmd, opts) {
      let command = cmd;
      if (opts?.stdin !== undefined) {
        const path = `/tmp/.oma-stdin-${crypto.randomUUID()}`;
        await runtimeCall(() => runtime.writeFile(path, opts.stdin!));
        command = `(${cmd}) < ${path}; s=$?; rm -f ${path}; exit $s`;
      }
      return runtimeCall(() => runtime.run(`cd /workspace 2>/dev/null; ${command}`, opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }));
    },
    readFile: (runtime, path) => runtimeCall(() => runtime.readBytes(path)),
    async writeFile(runtime, path, bytes) {
      await runtimeCall(() => runtime.writeFileBytes(path, bytes));
    },
    setEnv: (runtime, env) => runtime.setEnvVars(env),
    applyFirewall: (runtime, rules) => runtimeCall(() => runtime.updateNetwork(e2bNetwork(rules, options.channels ?? []))),
  };

  const objectStorage = options.objectStorage;
  return {
    name: "e2b",
    lifecycle,
    vendor,
    ...(objectStorage === undefined ? {} : {
      native: { storage: () => e2bObjectStorage(vendor, objectStorage) },
    }),
  };
}

/** Native storage: Memory Stores and /mnt/session/outputs as rclone FUSE
 * mounts over prefix-scoped, short-lived credentials. Parent keys never
 * enter the sandbox; the temporary credentials reach rclone only through
 * its process environment (RCLONE_S3_*), never its command line.
 *
 * The remote is rooted at the credential's prefix and runs with
 * --s3-no-check-bucket, so nothing touches the bucket root: s3fs 1.90
 * (Debian 12) probed `GET /<bucket>/`, which a prefix-scoped credential
 * correctly gets 403 for, retried with SigV2 (R2: 401) and exited after
 * daemonizing, so its exit 0 left a plain local directory. A mount process
 * exiting 0 proves nothing: every mount is then verified (`mountpoint -q`
 * and a listing through FUSE, which needs a working credential) and any
 * failure fails attach (design §0.0 rule 16).
 *
 * Mounts are live, so sync only renews credentials (re-mint + remount once
 * less than half the TTL is left; rclone reads them only at start), and
 * detach unmounts everything. */
export function e2bObjectStorage(
  vendor: SandboxVendorPort<E2BSandboxExecutor>,
  options: E2BObjectStorageOptions,
): SandboxStoragePort<E2BSandboxExecutor> {
  const ttlSeconds = options.ttlSeconds ?? 3_600;
  interface Mount { identity: string; expiresAt: number; issue(): ReturnType<ObjectStoreCredentialPort["issue"]>; readOnly: boolean }
  const mounted = new WeakMap<E2BSandboxExecutor, { owner: string; mounts: Map<string, Mount> }>();
  const fresh = (mount: Mount) => mount.expiresAt - Date.now() > (ttlSeconds * 1_000) / 2;
  const asRoot = async (runtime: E2BSandboxExecutor, command: string, envs?: Record<string, string>) => {
    // Storage traffic goes straight to the bucket, not through the agent's
    // egress relay: rclone's S3 SDK rejects the relay's AWS_CA_BUNDLE.
    const result = await runtimeCall(() => runtime.run(command, { user: "root", timeoutMs: 60_000, sessionEnv: false, ...(envs === undefined ? {} : { envs }) }));
    if (result.exitCode !== 0) throw new Error(`E2B storage command failed (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 300)}`);
  };
  const mount = async (runtime: E2BSandboxExecutor, owner: string, target: string, entry: Mount) => {
    const credentials = await entry.issue();
    const remote = `:s3:${credentials.bucket}/${credentials.prefix.replace(/\/$/u, "")}`;
    const flags = [
      "--daemon",
      "--s3-no-check-bucket",
      "--allow-other",
      "--allow-non-empty",
      `--uid=${owner}`,
      `--gid=${owner}`,
      "--vfs-cache-mode=writes",
      ...(entry.readOnly ? ["--read-only"] : []),
    ].map(quote).join(" ");
    await asRoot(
      runtime,
      `(mountpoint -q ${quote(target)} && (umount ${quote(target)} || umount -l ${quote(target)})) || true; `
        + `mkdir -p ${quote(target)} && rclone mount ${quote(remote)} ${quote(target)} ${flags}`,
      {
        RCLONE_S3_PROVIDER: "Cloudflare",
        RCLONE_S3_ENDPOINT: credentials.endpoint,
        RCLONE_S3_REGION: "auto",
        RCLONE_S3_ACCESS_KEY_ID: credentials.accessKeyId,
        RCLONE_S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        RCLONE_S3_SESSION_TOKEN: credentials.sessionToken,
      },
    );
    await verifyMount(runtime, target);
    entry.expiresAt = credentials.expiresAt;
  };
  /** The mount must be a FUSE mountpoint and its prefix listable through it. */
  const verifyMount = async (runtime: E2BSandboxExecutor, target: string) => {
    const result = await runtimeCall(() => runtime.run(
      `mountpoint -q ${quote(target)} || { echo 'not a mountpoint' >&2; exit 90; }; ls -A ${quote(target)} >/dev/null`,
      { user: "root", timeoutMs: 60_000, sessionEnv: false },
    ));
    if (result.exitCode !== 0) {
      throw new Error(`E2B storage mount ${target} is not usable (exit ${result.exitCode}): ${(result.stderr || result.stdout).slice(0, 300)}`);
    }
  };
  return {
    async attach(input) {
      const owner = (await vendor.exec(input.runtime, "id -u")).stdout.trim();
      await asRoot(input.runtime, `mkdir -p ${SESSION_OUTPUTS_DIR} /mnt/memory && chown ${quote(owner)} ${SESSION_OUTPUTS_DIR}`);
      const state = mounted.get(input.runtime) ?? { owner, mounts: new Map<string, Mount>() };
      mounted.set(input.runtime, state);
      const outputsPrefix = options.outputsPrefix(input.scope);
      const wanted: Array<[string, Mount]> = [[SESSION_OUTPUTS_DIR, {
        identity: `outputs:${outputsPrefix}`,
        expiresAt: 0,
        readOnly: false,
        issue: () => options.outputs.issue({ prefix: outputsPrefix, access: "read_write", ttlSeconds }),
      }]];
      for (const store of input.stores) {
        if (!/^[A-Za-z0-9._-]+$/u.test(store.storeName) || store.storeName.startsWith(".")) {
          throw new Error(`Unsafe Memory Store name: ${JSON.stringify(store.storeName)}`);
        }
        wanted.push([`/mnt/memory/${store.storeName}`, {
          identity: `memory:${store.storeId}:${store.readOnly ? "ro" : "rw"}`,
          expiresAt: 0,
          readOnly: store.readOnly,
          issue: () => options.memory.issue({ prefix: `${store.storeId}/`, access: store.readOnly ? "read_only" : "read_write", ttlSeconds }),
        }]);
      }
      for (const [target, entry] of wanted) {
        input.signal.throwIfAborted();
        const current = state.mounts.get(target);
        if (current !== undefined && current.identity === entry.identity && fresh(current)) continue;
        await mount(input.runtime, state.owner, target, entry);
        state.mounts.set(target, entry);
      }
    },
    async sync(input) {
      const state = mounted.get(input.runtime);
      if (state === undefined) return;
      for (const [target, entry] of state.mounts) {
        input.signal.throwIfAborted();
        if (!fresh(entry)) await mount(input.runtime, state.owner, target, entry);
      }
    },
    async detach(input) {
      const state = mounted.get(input.runtime);
      if (state === undefined) return;
      for (const target of state.mounts.keys()) {
        await asRoot(input.runtime, `umount ${quote(target)} || umount -l ${quote(target)} || true`);
      }
      mounted.delete(input.runtime);
    },
  };
}

/** FirewallRules → E2B network config. allowOut wins over denyOut; denyOut
 * takes CIDRs only (hostname denies are dropped), and loopback never leaves
 * the VM, so it is not sent. */
export function e2bNetwork(rules: FirewallRules, channels: readonly string[]): { allowOut: string[]; denyOut: string[] } {
  const denyCidrs = rules.denyAlways.filter((entry) => /^\d+\.\d+\.\d+\.\d+\/\d+$/u.test(entry) && !entry.startsWith("127."));
  if (rules.mode === "open") return { allowOut: [], denyOut: denyCidrs };
  return {
    allowOut: [...new Set([...rules.allowHosts, ...channels, ...rules.allowCidrs])],
    denyOut: ["0.0.0.0/0"],
  };
}

/** Not found: a missing sandbox, template or snapshot. */
export function isGone(error: unknown): boolean {
  const candidate = error as { name?: unknown; statusCode?: unknown } | null;
  if (candidate === null || typeof candidate !== "object") return false;
  return candidate.name === "SandboxNotFoundError" || candidate.name === "NotFoundError" || candidate.statusCode === 404;
}

/** Throttling / busy → RetryableSandboxError; anything else unchanged. */
export function mapError(error: unknown): unknown {
  const candidate = error as { name?: unknown; statusCode?: unknown; message?: unknown } | null;
  if (candidate !== null && typeof candidate === "object"
    && (candidate.name === "RateLimitError" || candidate.name === "ServiceBusyError" || candidate.statusCode === 429 || candidate.statusCode === 503)) {
    return new RetryableSandboxError(String(candidate.message ?? "E2B is busy"), DEFAULT_RETRY_AFTER_MS, { cause: error });
  }
  return error;
}

/** Lifecycle calls on a live sandbox: not found → SandboxGoneError. */
async function lifecycleCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isGone(error)) throw new SandboxGoneError("E2B sandbox disappeared", { cause: error });
    throw mapError(error);
  }
}

/** Exec / file calls: a sandbox that stopped answering → SandboxGoneError.
 * A missing file is not a missing sandbox and is handled by readBytes. */
async function runtimeCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === "SandboxNotFoundError" || name === "SandboxNotRunningError") {
      throw new SandboxGoneError("E2B sandbox is not running", { cause: error });
    }
    throw mapError(error);
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export type { E2BCreateOptions, ResumeRef };
