// Sandbox SDK v2 on E2B for the Cloudflare control plane (SANDBOX_ADAPTER=e2b).
//
// SessionDO keeps talking to a SandboxExecutor; this facade implements it
// over the v2 Ports from createSandboxPorts + createE2BV2Adapter:
//   - the sandbox is opened lazily: attach the saved handle, else acquire;
//     the handle lives in DO storage ("changes" handle);
//   - egress.attach runs once per open (provider firewall from the
//     Environment networking; no Vault substitutions on this path);
//   - Memory Stores are s3fs mounts with prefix-scoped temporary R2
//     credentials minted here from the memory-bucket key (the key itself
//     never enters the sandbox);
//   - /mnt/session/outputs is copied out at turn end into FILES_BUCKET
//     through the R2 binding (best effort, not a live mount).
// The Cloudflare path (SANDBOX_ADAPTER unset or "cloudflare") is unchanged.

import type {
  EgressPolicy,
  MemoryStoreBinding,
  SandboxDuplexProcess,
  SandboxDuplexProcessSpec,
  SandboxExecutor,
  SandboxHandle,
  SandboxPlan,
  SandboxPorts,
} from "@open-managed-agents/sandbox";
import { SandboxGoneError } from "@open-managed-agents/sandbox";
import type { RuntimeResourceFence, RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { createSandboxPorts, type SandboxOutputSinkPort, type SandboxVendorPort } from "@open-managed-agents/sandbox-port-kit";
import { createR2TemporaryCredentials } from "@open-managed-agents/sandbox-port-kit/object-storage";
import { createE2BV2Adapter, type E2BV2Module } from "@open-managed-agents/sandbox-adapter-e2b/v2";
import type { E2BSandboxExecutor } from "@open-managed-agents/sandbox-adapter-e2b";
import { sessionOutputsPrefix } from "@open-managed-agents/shared";

export interface E2BSandboxEnv {
  E2B_API_KEY?: string;
  E2B_TEMPLATE?: string;
  E2B_DOMAIN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  MEMORY_BUCKET_NAME?: string;
  FILES_BUCKET?: R2Bucket;
}

/** Networking as stored on the Environment config. */
export interface SessionNetworking {
  type?: string;
  allowed_hosts?: string[];
  allow_package_managers?: boolean;
}

const IDLE_MS = 5 * 60_000;
const LEASE_MS = 30 * 60_000;
const STATE_KEY = "e2b_sandbox_state";

/** Installs s3fs when missing, before the firewall is applied. */
export const E2B_SANDBOX_SETUP = [
  "mkdir -p /workspace /mnt/session/outputs /mnt/memory",
  "if ! command -v s3fs >/dev/null 2>&1; then",
  "  if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq s3fs >/dev/null;",
  "  elif command -v apk >/dev/null 2>&1; then apk add --no-cache s3fs-fuse >/dev/null;",
  "  else echo 'no package manager to install s3fs' >&2; exit 1; fi",
  "fi",
].join("\n");

const PACKAGE_HOSTS = [
  "pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "*.npmjs.org",
  "deb.debian.org", "security.debian.org", "archive.ubuntu.com", "security.ubuntu.com",
  "crates.io", "static.crates.io", "index.crates.io", "proxy.golang.org", "sum.golang.org", "rubygems.org",
];

interface PersistedState { handle: SandboxHandle; stores: MemoryStoreBinding[]; outputs: boolean }

export interface E2BSessionSandboxOptions {
  compose(): Promise<{ ports: SandboxPorts<E2BSandboxExecutor>; vendor: SandboxVendorPort<E2BSandboxExecutor> }>;
  state: {
    load(): Promise<PersistedState | undefined>;
    save(state: PersistedState): Promise<void>;
    clear(): Promise<void>;
  };
  scope(): RuntimeResourceScope;
  plan(scope: RuntimeResourceScope, stores: MemoryStoreBinding[]): Promise<SandboxPlan>;
}

/** SandboxExecutor over the v2 Ports. Exec output uses the Cloudflare
 * `exit=N\n<stdout>\nstderr: <stderr>` shape SessionDO's probes read. */
export class E2BSessionSandbox implements SandboxExecutor {
  private live: { runtime: E2BSandboxExecutor; handle: SandboxHandle } | null = null;
  private opening: Promise<{ runtime: E2BSandboxExecutor; handle: SandboxHandle }> | null = null;
  private composed: ReturnType<E2BSessionSandboxOptions["compose"]> | null = null;
  private env: Record<string, string> = {};
  private stores: MemoryStoreBinding[] = [];
  private outputs = false;

  constructor(private readonly options: E2BSessionSandboxOptions) {}

  async exec(command: string, timeout?: number): Promise<string> {
    const result = await this.call((runtime) => runtime.run(command, timeout === undefined ? {} : { timeoutMs: timeout }));
    return `exit=${result.exitCode}\n${result.stdout}${result.stderr ? `\nstderr: ${result.stderr}` : ""}`;
  }
  startProcess(command: string) { return this.call((runtime) => runtime.startProcess(command)); }
  spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    return this.call((runtime) => runtime.spawnDuplexProcess(spec));
  }
  readFile(path: string) { return this.call((runtime) => runtime.readFile(path)); }
  readFileBytes(path: string) { return this.call((runtime) => runtime.readFileBytes(path)); }
  writeFile(path: string, content: string) { return this.call((runtime) => runtime.writeFile(path, content)); }
  writeFileBytes(path: string, bytes: Uint8Array) { return this.call((runtime) => runtime.writeFileBytes(path, bytes)); }

  async setEnvVars(env: Record<string, string>): Promise<void> {
    this.env = { ...this.env, ...env };
    if (this.live !== null) await this.live.runtime.setEnvVars(env);
  }

  async mountMemoryStore(store: MemoryStoreBinding): Promise<void> {
    this.stores = [...this.stores.filter((item) => item.storeName !== store.storeName), store];
    await this.attachStorage();
  }

  sessionOutputMountCapabilities(): { durability: "best_effort" } {
    return { durability: "best_effort" };
  }

  async mountSessionOutputs(): Promise<void> {
    this.outputs = true;
    await this.attachStorage();
  }

  /** Turn end: publish /mnt/session/outputs (Memory mounts are write-through). */
  async syncStorage(reason: "turn_end" | "before_stop"): Promise<void> {
    if (this.live === null || !this.outputs) return;
    const { ports } = await this.compose();
    const scope = this.options.scope();
    const plan = await this.options.plan(scope, this.stores);
    await ports.storage.sync({ runtime: this.live.runtime, scope, fence: fenceFor(scope), stores: this.stores, outputs: plan.outputs, reason, signal: new AbortController().signal });
  }

  async renewActivityTimeout(): Promise<void> {
    if (this.live === null) return;
    const { ports } = await this.compose();
    if (await ports.sandbox.keepAlive(this.live) === "gone") this.live = null;
  }

  async destroy(): Promise<void> {
    const { ports } = await this.compose();
    const scope = this.options.scope();
    const live = this.live;
    this.live = null;
    if (live !== null) {
      await ports.storage.detach({ runtime: live.runtime, scope }).catch(() => undefined);
      await ports.egress.revoke({ runtime: live.runtime, scope, fence: fenceFor(scope), reason: "completed" }).catch(() => undefined);
    }
    const handle = live?.handle ?? (await this.options.state.load())?.handle;
    if (handle !== undefined) await ports.sandbox.release({ scope, handle });
    await this.options.state.clear();
  }

  private compose() {
    return this.composed ??= this.options.compose();
  }

  private async attachStorage(): Promise<void> {
    const opened = this.live === null;
    const { runtime, handle } = await this.open();
    // A fresh open already attached the current stores and outputs.
    if (opened) return;
    await this.options.state.save({ handle, stores: this.stores, outputs: this.outputs });
    const { ports } = await this.compose();
    const scope = this.options.scope();
    const plan = await this.options.plan(scope, this.stores);
    await ports.storage.attach({ runtime, scope, fence: fenceFor(scope), stores: this.stores, outputs: plan.outputs, signal: new AbortController().signal });
  }

  private async call<T>(operation: (runtime: E2BSandboxExecutor) => Promise<T>): Promise<T> {
    const { runtime } = await this.open();
    try {
      return await operation(runtime);
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      if (error instanceof SandboxGoneError || name === "SandboxNotFoundError" || name === "SandboxNotRunningError") this.live = null;
      throw error;
    }
  }

  private open() {
    if (this.live !== null) return Promise.resolve(this.live);
    return this.opening ??= this.start().finally(() => { this.opening = null; });
  }

  private async start(): Promise<{ runtime: E2BSandboxExecutor; handle: SandboxHandle }> {
    const { ports } = await this.compose();
    const scope = this.options.scope();
    const signal = new AbortController().signal;
    const saved = await this.options.state.load();
    if (saved !== undefined) {
      this.stores = mergeStores(saved.stores, this.stores);
      this.outputs ||= saved.outputs;
    }
    const plan = await this.options.plan(scope, this.stores);
    let acquired = saved === undefined ? "gone" as const : await ports.sandbox.attach({ scope, handle: saved.handle, signal });
    if (acquired === "gone") {
      if (saved !== undefined) await ports.sandbox.release({ scope, handle: saved.handle }).catch(() => undefined);
      acquired = await ports.sandbox.acquire({ scope, plan, signal });
      if (acquired === "gone") throw new Error(`E2B template ${JSON.stringify(plan.from)} was not found`);
    }
    await this.options.state.save({ handle: acquired.handle, stores: this.stores, outputs: this.outputs });
    if (Object.keys(this.env).length > 0) await acquired.runtime.setEnvVars(this.env);
    const fence = fenceFor(scope);
    await ports.egress.attach({ runtime: acquired.runtime, scope, fence, policy: plan.egress, signal });
    if (this.outputs || this.stores.length > 0) {
      await ports.storage.attach({ runtime: acquired.runtime, scope, fence, stores: this.stores, outputs: plan.outputs, signal });
    }
    this.live = acquired;
    return acquired;
  }
}

/** Builds the facade from Worker env. Missing configuration fails here with
 * the variable names. The e2b SDK is imported only when a sandbox opens. */
export function createE2BSessionSandbox(input: {
  env: E2BSandboxEnv;
  storage: Pick<DurableObjectStorage, "get" | "put" | "delete">;
  scope(): RuntimeResourceScope;
  networking(): Promise<SessionNetworking | undefined>;
}): E2BSessionSandbox {
  const { env } = input;
  const missing = (["E2B_API_KEY", "E2B_TEMPLATE", "CLOUDFLARE_ACCOUNT_ID", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "MEMORY_BUCKET_NAME"] as const)
    .filter((name) => !env[name]);
  if (missing.length > 0 || env.FILES_BUCKET === undefined) {
    throw new Error(`SANDBOX_ADAPTER=e2b requires ${[...missing, ...(env.FILES_BUCKET === undefined ? ["FILES_BUCKET"] : [])].join(", ")}`);
  }
  const files = env.FILES_BUCKET;
  const template = env.E2B_TEMPLATE!;
  return new E2BSessionSandbox({
    async compose() {
      const sdk = await import("e2b") as unknown as E2BV2Module;
      const adapter = createE2BV2Adapter({
        sdk,
        connection: { apiKey: env.E2B_API_KEY!, ...(env.E2B_DOMAIN ? { domain: env.E2B_DOMAIN } : {}) },
        leaseMs: LEASE_MS,
        user: "root",
        setup: E2B_SANDBOX_SETUP,
        channels: [new URL(env.R2_ENDPOINT!).hostname],
        objectStorage: {
          credentials: createR2TemporaryCredentials({
            accountId: env.CLOUDFLARE_ACCOUNT_ID!,
            endpoint: env.R2_ENDPOINT!,
            bucket: env.MEMORY_BUCKET_NAME!,
            accessKeyId: env.R2_ACCESS_KEY_ID!,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
          }),
        },
      });
      const { ports } = createSandboxPorts(adapter, {
        storage: {
          memories: () => {
            throw new Error("E2B Memory Stores are s3fs mounts; the file-sync Memory API is not used");
          },
          outputs: createR2BindingOutputSink(files, (scope) => sessionOutputsPrefix(scope.workspaceId, scope.sessionId)),
          // SessionDO is the single writer of its Session.
          authorize: async () => true,
        },
        egress: {
          gateway: {
            // No Vault substitutions on this path, so the forwarder is never
            // installed and the gateway is never contacted.
            endpoint: { url: "https://egress.invalid/" },
            issueToken: async () => { throw new Error("Vault egress is not available on SANDBOX_ADAPTER=e2b"); },
            authenticate: async () => null,
            handle: async () => new Response("Vault egress is not available on SANDBOX_ADAPTER=e2b", { status: 403 }),
          },
        },
      });
      return { ports, vendor: adapter.vendor };
    },
    state: {
      load: () => input.storage.get<PersistedState>(STATE_KEY),
      save: (state) => input.storage.put(STATE_KEY, state),
      clear: async () => { await input.storage.delete(STATE_KEY); },
    },
    scope: input.scope,
    async plan(scope, stores) {
      return {
        from: { image: template },
        egress: egressPolicy(scope, await input.networking()),
        stores,
        outputs: { bindingId: `outputs:${scope.sessionId}`, mountPath: "/mnt/session/outputs" },
        idleMs: IDLE_MS,
        labels: { workspaceId: scope.workspaceId, sessionId: scope.sessionId },
      };
    },
  });
}

/** Environment networking → EgressPolicy. Unrestricted (or unset) → null. */
export function egressPolicy(scope: RuntimeResourceScope, networking: SessionNetworking | undefined): EgressPolicy | null {
  if (networking?.type !== "limited") return null;
  return {
    scope: { workspaceId: scope.workspaceId, sessionId: scope.sessionId, generation: 1 },
    networking: {
      type: "limited",
      hosts: [...(networking.allowed_hosts ?? [])],
      packageSources: networking.allow_package_managers ? [...PACKAGE_HOSTS] : [],
      mcpHosts: [],
    },
    substitutions: [],
  };
}

/** Publishes outputs into FILES_BUCKET through the R2 binding (the S3 key is
 * scoped to the memory bucket). Replaces the Session's previous set. */
export function createR2BindingOutputSink(bucket: R2Bucket, keyPrefix: (scope: RuntimeResourceScope) => string): SandboxOutputSinkPort {
  return {
    async publish(input) {
      const prefix = keyPrefix(input.scope);
      const previous = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
        for (const object of page.objects) previous.add(object.key);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      for await (const [logicalPath, bytes] of input.files) {
        input.signal.throwIfAborted();
        if (logicalPath === "" || logicalPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
          throw new Error(`Unsafe Session output path: ${JSON.stringify(logicalPath)}`);
        }
        await bucket.put(`${prefix}${logicalPath}`, bytes);
        previous.delete(`${prefix}${logicalPath}`);
      }
      if (previous.size > 0) await bucket.delete([...previous]);
    },
  };
}

function fenceFor(scope: RuntimeResourceScope): RuntimeResourceFence {
  return { ...scope, ownerId: "session-do", generation: 1, token: "session-do", expiresAt: "9999-12-31T00:00:00.000Z" };
}

function mergeStores(saved: MemoryStoreBinding[], current: MemoryStoreBinding[]): MemoryStoreBinding[] {
  const byName = new Map(saved.map((store) => [store.storeName, store]));
  for (const store of current) byName.set(store.storeName, store);
  return [...byName.values()];
}
