// Sandbox SDK v2 on E2B for the Cloudflare control plane (SANDBOX_ADAPTER=e2b).
//
// SessionDO keeps talking to a SandboxExecutor; this facade implements it
// over the v2 Ports from createSandboxPorts + createE2BV2Adapter:
//   - the sandbox is opened lazily: attach the saved handle, else acquire;
//     the handle lives in DO storage ("changes" handle);
//   - egress.attach runs at every open: the Environment networking becomes
//     the E2B firewall, and when the Session has cap_cli Vault credentials
//     the in-sandbox relay (packages/sandbox-egress) forwards their hosts to
//     the control plane's HTTPS /v1/oma/egress ingress with a Session-scoped
//     relay pass. Real credentials never enter the sandbox;
//   - storage is one deployment choice (storageConfig): both bucket parent
//     keys configured → native s3fs mounts for Memory and outputs over
//     prefix-scoped temporary credentials; neither → createSyncStorage copies
//     Memory in and out (over the MEMORY_BUCKET projection prefixes) and
//     uploads /mnt/session/outputs into FILES_BUCKET at turn end; exactly one
//     → configuration error;
//   - temporary credentials (mount credentials, relay pass) are renewed at
//     exec boundaries, see E2BSessionSandbox.maintain.
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
  Substitution,
} from "@open-managed-agents/sandbox";
import { SandboxGoneError } from "@open-managed-agents/sandbox";
import type { RuntimeResourceFence, RuntimeResourceScope, SessionOutputBinding } from "@open-managed-agents/runtime-resource-contract";
import { createSandboxPorts, type SandboxOutputSinkPort, type SandboxVendorPort } from "@open-managed-agents/sandbox-port-kit";
import { createR2TemporaryCredentials } from "@open-managed-agents/sandbox-port-kit/object-storage";
import { createE2BV2Adapter, type E2BObjectStorageOptions, type E2BV2Module } from "@open-managed-agents/sandbox-adapter-e2b/v2";
import type { E2BSandboxExecutor } from "@open-managed-agents/sandbox-adapter-e2b";
import { createEgressRelayPasses, EGRESS_RELAY_PATH } from "@open-managed-agents/managed-credential-resolver";
import { sessionOutputsPrefix } from "@open-managed-agents/shared";
import { createR2MemoryPrefixAccess, type MemoryPrefixBucket } from "./r2-memory-access";

export interface E2BSandboxEnv {
  E2B_API_KEY?: string;
  E2B_TEMPLATE?: string;
  E2B_DOMAIN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  R2_ENDPOINT?: string;
  /** Memory bucket parent key (native storage). */
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  MEMORY_BUCKET_NAME?: string;
  /** Files bucket parent key (native storage). */
  R2_FILES_ACCESS_KEY_ID?: string;
  R2_FILES_SECRET_ACCESS_KEY?: string;
  FILES_BUCKET_NAME?: string;
  /** Bindings for the generic sync. */
  MEMORY_BUCKET?: MemoryPrefixBucket;
  FILES_BUCKET?: R2Bucket;
  /** Vault egress: relay-pass key and the control plane's public HTTPS origin. */
  PLATFORM_ROOT_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  MAIN_MCP?: {
    resolveManagedCapCliEnvironment(opts: { tenantId: string; sessionId: string }): Promise<
      { type: "found"; env: Record<string, string> } | { type: "not_found" }
    >;
  };
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
/** Lifetime of a relay pass; the relay is re-attached with a new one after half. */
export const RELAY_PASS_TTL_MS = 60 * 60_000;
/** Interval write-back / credential renewal at exec boundaries (design §0.1 step 5). */
export const STORAGE_SYNC_INTERVAL_MS = 15_000;

/** Creates the mount points; native storage also installs s3fs. Runs as
 * root right after a sandbox starts, before its firewall is applied. */
export const E2B_SANDBOX_DIRECTORIES = "mkdir -p /workspace /mnt/session/outputs /mnt/memory";
export const E2B_SANDBOX_SETUP = [
  E2B_SANDBOX_DIRECTORIES,
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
  now(): number;
}

/** SandboxExecutor over the v2 Ports. Exec output uses the Cloudflare
 * `exit=N\n<stdout>\nstderr: <stderr>` shape SessionDO's probes read. */
export class E2BSessionSandbox implements SandboxExecutor {
  private live: { runtime: E2BSandboxExecutor; handle: SandboxHandle } | null = null;
  private opening: Promise<{ runtime: E2BSandboxExecutor; handle: SandboxHandle }> | null = null;
  private maintaining: Promise<void> | null = null;
  private composed: ReturnType<E2BSessionSandboxOptions["compose"]> | null = null;
  private env: Record<string, string> = {};
  private stores: MemoryStoreBinding[] = [];
  private outputs = false;
  /** The sandbox disappeared since the last turn-end sync: what it held was not published. */
  private lost = false;
  private storageSyncedAt = 0;
  private egressAttachedAt = 0;

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

  /** Turn end: storage.sync (native: credential renewal; sync: Memory
   * write-back + pull and the outputs upload). Any failure, including a
   * sandbox lost during the turn, is an error for the caller. */
  async syncStorage(reason: "turn_end" | "before_stop"): Promise<void> {
    if (this.lost) {
      this.lost = false;
      throw new SandboxGoneError("The E2B sandbox was lost during the turn; its Memory and outputs changes were not published");
    }
    if (this.live === null || (!this.outputs && this.stores.length === 0)) return;
    const { ports } = await this.compose();
    const scope = this.options.scope();
    await ports.storage.sync({ runtime: this.live.runtime, scope, fence: fenceFor(scope), stores: this.stores, outputs: outputsBinding(scope), reason, signal: new AbortController().signal });
    this.storageSyncedAt = this.options.now();
  }

  async renewActivityTimeout(): Promise<void> {
    if (this.live === null) return;
    const { ports } = await this.compose();
    if (await ports.sandbox.keepAlive(this.live) === "gone") {
      this.markLost();
      return;
    }
    await this.maintain(this.live);
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

  private markLost(): void {
    this.live = null;
    if (this.outputs || this.stores.length > 0) this.lost = true;
  }

  private async attachStorage(): Promise<void> {
    const opened = this.live === null;
    const { runtime, handle } = await this.open();
    // A fresh open already attached the current stores and outputs.
    if (opened) return;
    await this.options.state.save({ handle, stores: this.stores, outputs: this.outputs });
    const { ports } = await this.compose();
    const scope = this.options.scope();
    await ports.storage.attach({ runtime, scope, fence: fenceFor(scope), stores: this.stores, outputs: outputsBinding(scope), signal: new AbortController().signal });
  }

  private async call<T>(operation: (runtime: E2BSandboxExecutor) => Promise<T>): Promise<T> {
    const live = await this.open();
    try {
      await this.maintain(live);
      return await operation(live.runtime);
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      if (error instanceof SandboxGoneError || name === "SandboxNotFoundError" || name === "SandboxNotRunningError") this.markLost();
      throw error;
    }
  }

  /** Renews temporary credentials at exec boundaries (Workers cannot keep a
   * timer): storage.sync("interval") every STORAGE_SYNC_INTERVAL_MS (native:
   * remount stores whose credentials passed half their TTL; sync: write
   * Memory back), and egress.attach with a new relay pass once the current
   * one passed half its TTL. Single-flight; a failure fails the call. */
  private maintain(live: { runtime: E2BSandboxExecutor; handle: SandboxHandle }): Promise<void> {
    return this.maintaining ??= (async () => {
      const now = this.options.now();
      const { ports } = await this.compose();
      const scope = this.options.scope();
      const signal = new AbortController().signal;
      if (now - this.storageSyncedAt >= STORAGE_SYNC_INTERVAL_MS && (this.outputs || this.stores.length > 0)) {
        await ports.storage.sync({ runtime: live.runtime, scope, fence: fenceFor(scope), stores: this.stores, outputs: outputsBinding(scope), reason: "interval", signal });
        this.storageSyncedAt = now;
      }
      if (now - this.egressAttachedAt >= RELAY_PASS_TTL_MS / 2) {
        const plan = await this.options.plan(scope, this.stores);
        await ports.egress.attach({ runtime: live.runtime, scope, fence: fenceFor(scope), policy: plan.egress, signal });
        this.egressAttachedAt = now;
      }
    })().finally(() => { this.maintaining = null; });
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
    this.egressAttachedAt = this.options.now();
    if (this.outputs || this.stores.length > 0) {
      await ports.storage.attach({ runtime: acquired.runtime, scope, fence, stores: this.stores, outputs: plan.outputs, signal });
    }
    this.storageSyncedAt = this.options.now();
    this.live = acquired;
    return acquired;
  }
}

/** The one storage switch: native mounts when both bucket parent keys are
 * configured, the generic sync when neither is. A key for only one bucket
 * would leave Memory and outputs on different paths: rejected. */
export function storageConfig(env: E2BSandboxEnv): { kind: "native"; objectStorage: E2BObjectStorageOptions } | { kind: "sync"; memory: MemoryPrefixBucket; files: R2Bucket } {
  const memoryKey = Boolean(env.R2_ACCESS_KEY_ID || env.R2_SECRET_ACCESS_KEY);
  const filesKey = Boolean(env.R2_FILES_ACCESS_KEY_ID || env.R2_FILES_SECRET_ACCESS_KEY);
  if (memoryKey !== filesKey) {
    throw new Error(
      "SANDBOX_ADAPTER=e2b storage is half configured: native mounts need both the memory bucket key "
        + "(R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) and the files bucket key (R2_FILES_ACCESS_KEY_ID, R2_FILES_SECRET_ACCESS_KEY); "
        + "set both for mounts, or neither for the copy sync",
    );
  }
  if (memoryKey) {
    const required = ["CLOUDFLARE_ACCOUNT_ID", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "MEMORY_BUCKET_NAME", "R2_FILES_ACCESS_KEY_ID", "R2_FILES_SECRET_ACCESS_KEY", "FILES_BUCKET_NAME"] as const;
    const missing = required.filter((name) => !env[name]);
    if (missing.length > 0) throw new Error(`SANDBOX_ADAPTER=e2b native storage requires ${missing.join(", ")}`);
    const parent = (bucket: string, accessKeyId: string, secretAccessKey: string) =>
      createR2TemporaryCredentials({ accountId: env.CLOUDFLARE_ACCOUNT_ID!, endpoint: env.R2_ENDPOINT!, bucket, accessKeyId, secretAccessKey });
    return {
      kind: "native",
      objectStorage: {
        memory: parent(env.MEMORY_BUCKET_NAME!, env.R2_ACCESS_KEY_ID!, env.R2_SECRET_ACCESS_KEY!),
        outputs: parent(env.FILES_BUCKET_NAME!, env.R2_FILES_ACCESS_KEY_ID!, env.R2_FILES_SECRET_ACCESS_KEY!),
        outputsPrefix: (scope) => sessionOutputsPrefix(scope.workspaceId, scope.sessionId),
      },
    };
  }
  const missing = [...(env.MEMORY_BUCKET === undefined ? ["MEMORY_BUCKET"] : []), ...(env.FILES_BUCKET === undefined ? ["FILES_BUCKET"] : [])];
  if (missing.length > 0) throw new Error(`SANDBOX_ADAPTER=e2b copy sync requires the ${missing.join(", ")} binding`);
  return { kind: "sync", memory: env.MEMORY_BUCKET!, files: env.FILES_BUCKET! };
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
  const missing = (["E2B_API_KEY", "E2B_TEMPLATE"] as const).filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`SANDBOX_ADAPTER=e2b requires ${missing.join(", ")}`);
  const storage = storageConfig(env);
  const template = env.E2B_TEMPLATE!;
  const passes = env.PLATFORM_ROOT_SECRET ? createEgressRelayPasses(env.PLATFORM_ROOT_SECRET, Date.now) : null;
  const gateway = env.PUBLIC_BASE_URL;
  return new E2BSessionSandbox({
    async compose() {
      const sdk = await import("e2b") as unknown as E2BV2Module;
      const adapter = createE2BV2Adapter({
        sdk,
        connection: { apiKey: env.E2B_API_KEY!, ...(env.E2B_DOMAIN ? { domain: env.E2B_DOMAIN } : {}) },
        leaseMs: LEASE_MS,
        user: "root",
        ...(storage.kind === "native"
          ? { setup: E2B_SANDBOX_SETUP, channels: [new URL(env.R2_ENDPOINT!).hostname], objectStorage: storage.objectStorage }
          : { setup: E2B_SANDBOX_DIRECTORIES }),
      });
      const { ports } = createSandboxPorts(adapter, {
        // Used only by the generic sync (no native storage).
        storage: {
          memories: () => {
            if (storage.kind !== "sync") throw new Error("E2B native storage mounts Memory; the copy sync is not composed");
            return createR2MemoryPrefixAccess(storage.memory);
          },
          outputs: {
            publish: (publication) => {
              if (storage.kind !== "sync") throw new Error("E2B native storage mounts outputs; the copy sync is not composed");
              return createR2BindingOutputSink(storage.files, (scope) => sessionOutputsPrefix(scope.workspaceId, scope.sessionId)).publish(publication);
            },
          },
          // SessionDO is the single writer of its Session.
          authorize: async () => true,
        },
        egress: {
          gateway: {
            // The relay calls <endpoint>/v1/oma/egress/{resolve,forward}: the
            // control plane's existing ingress (apps/main), which verifies the
            // pass and the Session itself.
            endpoint: { url: gateway ?? "https://egress-unconfigured.invalid" },
            issueToken: async ({ scope }) => {
              if (passes === null || gateway === undefined) {
                throw new Error("Vault credential egress on SANDBOX_ADAPTER=e2b requires PLATFORM_ROOT_SECRET and PUBLIC_BASE_URL");
              }
              return passes.issue({ workspaceId: scope.workspaceId, sessionId: scope.sessionId, ttlMs: RELAY_PASS_TTL_MS });
            },
            authenticate: async () => null,
            handle: async () => new Response(`Credential egress is served by the control plane at ${EGRESS_RELAY_PATH}`, { status: 404 }),
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
        egress: egressPolicy(scope, await input.networking(), await capCliSubstitutions(env, scope)),
        stores,
        outputs: outputsBinding(scope),
        idleMs: IDLE_MS,
        labels: { workspaceId: scope.workspaceId, sessionId: scope.sessionId },
      };
    },
    now: Date.now,
  });
}

/** The Session's cap_cli placeholders, from the same main-worker RPC SessionDO
 * uses for the placeholder env. The relay matches hosts at the gateway
 * (/resolve), so a substitution only marks "this Session needs the relay"
 * and carries its placeholder; credentialId is a label, not a Vault id. */
export async function capCliSubstitutions(env: Pick<E2BSandboxEnv, "MAIN_MCP">, scope: RuntimeResourceScope): Promise<Substitution[]> {
  if (env.MAIN_MCP === undefined) return [];
  const resolved = await env.MAIN_MCP.resolveManagedCapCliEnvironment({ tenantId: scope.workspaceId, sessionId: scope.sessionId });
  if (resolved.type !== "found") return [];
  return Object.entries(resolved.env).map(([envName, placeholder]) => ({
    credentialId: `cap_cli:${envName}`,
    envName,
    placeholder,
    hosts: [],
    inject: { header: true, body: false },
  }));
}

/** Environment networking + substitutions → EgressPolicy. Unrestricted (or
 * unset) without substitutions → null. */
export function egressPolicy(scope: RuntimeResourceScope, networking: SessionNetworking | undefined, substitutions: Substitution[] = []): EgressPolicy | null {
  if (networking?.type !== "limited" && substitutions.length === 0) return null;
  return {
    scope: { workspaceId: scope.workspaceId, sessionId: scope.sessionId, generation: 1 },
    networking: networking?.type === "limited"
      ? {
          type: "limited",
          hosts: [...(networking.allowed_hosts ?? [])],
          packageSources: networking.allow_package_managers ? [...PACKAGE_HOSTS] : [],
          mcpHosts: [],
        }
      : { type: "unrestricted" },
    substitutions,
  };
}

/** Publishes outputs into FILES_BUCKET through the R2 binding. Replaces the
 * Session's previous set; any failed put or delete rejects. */
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

function outputsBinding(scope: RuntimeResourceScope): SessionOutputBinding {
  return { bindingId: `outputs:${scope.sessionId}`, mountPath: "/mnt/session/outputs" };
}

function fenceFor(scope: RuntimeResourceScope): RuntimeResourceFence {
  return { ...scope, ownerId: "session-do", generation: 1, token: "session-do", expiresAt: "9999-12-31T00:00:00.000Z" };
}

function mergeStores(saved: MemoryStoreBinding[], current: MemoryStoreBinding[]): MemoryStoreBinding[] {
  const byName = new Map(saved.map((store) => [store.storeName, store]));
  for (const store of current) byName.set(store.storeName, store);
  return [...byName.values()];
}
