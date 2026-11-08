// Sandbox SDK v2 on E2B for the Cloudflare control plane (SANDBOX_ADAPTER=e2b).
//
// Composition only: createSandboxPorts + createE2BV2Adapter, handed to the
// shared Session runtime (session-sandbox.ts):
//   - the handle lives in DO storage ("changes" handle);
//   - egress: the Environment networking becomes the E2B firewall, and when
//     the Session has cap_cli Vault credentials the in-sandbox relay
//     (packages/sandbox-egress) forwards their hosts to the control plane's
//     HTTPS /v1/oma/egress ingress with a relay pass bound to the Session
//     execution attempt (design §0.0 rule 10; none between turns). Real
//     credentials never enter the sandbox. The pass expires, so the shared
//     runtime re-attaches egress after half its TTL (egressRenewMs) and when
//     the attempt changes (execution);
//   - storage is one deployment choice (storageConfig): both bucket parent
//     keys configured → native rclone mounts for Memory and outputs over
//     prefix-scoped temporary credentials (renewed by the runtime's interval
//     sync); neither → createSyncStorage copies Memory in and out (over the
//     MEMORY_BUCKET projection prefixes) and uploads /mnt/session/outputs into
//     FILES_BUCKET at turn end; exactly one → configuration error;
//   - E2B_MAX_LIFETIME_MS (required, the account plan's continuous-run cap)
//     becomes the adapter's maxLifetimeMs; the shared runtime refreshes the
//     sandbox before it (design §0.0 rule 11).

import type {
  MemoryStoreBinding,
  SandboxPlan,
  SandboxPorts,
  Substitution,
} from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope, SessionOutputBinding } from "@open-managed-agents/runtime-resource-contract";
import { createSandboxPorts, placeholderSubstitutions, sessionEgressPolicy, type SandboxOutputSinkPort, type SandboxVendorPort, type SessionNetworking } from "@open-managed-agents/sandbox-port-kit";
import { createR2TemporaryCredentials } from "@open-managed-agents/sandbox-port-kit/object-storage";
import { createE2BV2Adapter, E2B_SANDBOX_DIRECTORIES, E2B_SANDBOX_SETUP, type E2BObjectStorageOptions, type E2BV2Module } from "@open-managed-agents/sandbox-adapter-e2b/v2";
import type { E2BSandboxExecutor } from "@open-managed-agents/sandbox-adapter-e2b";
import { createEgressRelayPasses, EGRESS_RELAY_PATH } from "@open-managed-agents/managed-credential-resolver";
import { issueSandboxRelayPass } from "@open-managed-agents/sandbox-gateway";
import { sandboxExecutionFenceKey, type SandboxExecutionFence } from "./cloudflare-session-sandbox";
import { sessionOutputsPrefix } from "@open-managed-agents/shared";
import { createR2MemoryPrefixAccess, type MemoryPrefixBucket } from "./r2-memory-access";
import { PortsSessionSandbox, type SessionSandboxExecutor, type SessionSandboxState } from "@open-managed-agents/session-runtime";

export interface E2BSandboxEnv {
  E2B_API_KEY?: string;
  E2B_TEMPLATE?: string;
  E2B_DOMAIN?: string;
  /** The account plan's continuous-run cap in ms (Hobby 3600000, Pro 86400000). */
  E2B_MAX_LIFETIME_MS?: string;
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

const IDLE_MS = 5 * 60_000;
const LEASE_MS = 30 * 60_000;
const STATE_KEY = "e2b_sandbox_state";
/** Lifetime of a relay pass; the relay is re-attached with a new one after half. */
export const RELAY_PASS_TTL_MS = 60 * 60_000;

type PersistedState = SessionSandboxState;

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
  /** The Session's current execution attempt; omitted = egress never rebinds on it. */
  fence?(): SandboxExecutionFence | undefined;
}

/** The shared Session runtime on E2B. Exec output uses the Cloudflare
 * `exit=N\n<stdout>\nstderr: <stderr>` shape SessionDO's probes read. */
export class E2BSessionSandbox extends PortsSessionSandbox<E2BSandboxExecutor> {
  constructor(options: E2BSessionSandboxOptions) {
    super({
      compose: options.compose,
      executor: e2bExecutor,
      state: options.state,
      scope: options.scope,
      plan: ({ scope, stores }) => options.plan(scope, stores),
      // E2B paused sandboxes are found again by attach; there is no
      // separately published restore point on this path.
      resumeRef: async () => null,
      warn: () => undefined,
      outputDurability: () => ({ durability: "best_effort" }),
      egressRenewMs: RELAY_PASS_TTL_MS / 2,
      ...(options.fence === undefined ? {} : {
        execution: () => options.fence!(),
        isCurrent: async (execution) => execution === undefined || sandboxExecutionFenceKey(options.fence!()) === sandboxExecutionFenceKey(execution),
      }),
      now: options.now,
    });
  }
}

function e2bExecutor(runtime: E2BSandboxExecutor): SessionSandboxExecutor {
  return {
    async exec(command, timeout) {
      const result = await runtime.run(command, timeout === undefined ? {} : { timeoutMs: timeout });
      return `exit=${result.exitCode}\n${result.stdout}${result.stderr ? `\nstderr: ${result.stderr}` : ""}`;
    },
    startProcess: (command) => runtime.startProcess(command),
    spawnDuplexProcess: (spec) => runtime.spawnDuplexProcess(spec),
    readFile: (path) => runtime.readFile(path),
    writeFile: (path, content) => runtime.writeFile(path, content),
    writeFileBytes: (path, bytes) => runtime.writeFileBytes(path, bytes),
    setEnvVars: (env) => runtime.setEnvVars(env),
  };
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
  fence(): SandboxExecutionFence | undefined;
}): E2BSessionSandbox {
  const { env } = input;
  const missing = (["E2B_API_KEY", "E2B_TEMPLATE", "E2B_MAX_LIFETIME_MS"] as const).filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`SANDBOX_ADAPTER=e2b requires ${missing.join(", ")}`);
  const maxLifetimeMs = parseMaxLifetime(env.E2B_MAX_LIFETIME_MS!);
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
        maxLifetimeMs,
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
            read: (input) => {
              if (storage.kind !== "sync") throw new Error("E2B native storage mounts outputs; the copy sync is not composed");
              return createR2BindingOutputSink(storage.files, (scope) => sessionOutputsPrefix(scope.workspaceId, scope.sessionId)).read(input);
            },
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
            issueToken: async ({ attempt }) => {
              if (passes === null || gateway === undefined) {
                throw new Error("Vault credential egress on SANDBOX_ADAPTER=e2b requires PLATFORM_ROOT_SECRET and PUBLIC_BASE_URL");
              }
              return issueSandboxRelayPass((claims) => passes.issue(claims), attempt, RELAY_PASS_TTL_MS);
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
        egress: sessionEgressPolicy(scope, await input.networking(), await capCliSubstitutions(env, scope)),
        stores,
        outputs: outputsBinding(scope),
        idleMs: IDLE_MS,
        labels: { workspaceId: scope.workspaceId, sessionId: scope.sessionId },
      };
    },
    now: Date.now,
    fence: input.fence,
  });
}

/** E2B_MAX_LIFETIME_MS → ms. The idle window must fit inside it (design
 * §0.0 rule 11), checked here at assembly with the deployment's idle time. */
export function parseMaxLifetime(value: string): number {
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error("E2B_MAX_LIFETIME_MS must be a positive integer of milliseconds (the E2B plan's continuous-run cap: Hobby 3600000, Pro 86400000)");
  }
  if (IDLE_MS >= ms) throw new Error(`E2B_MAX_LIFETIME_MS (${ms}) must exceed the idle pause window (${IDLE_MS} ms)`);
  return ms;
}

/** The Session's sandbox placeholders (environment_variable and cap_cli,
 * design §0.1), from the same main-worker RPC SessionDO uses for the
 * placeholder env. The gateway holds the hosts and values and matches them
 * (/resolve, /forward), so a substitution here only marks "this Session
 * needs the forwarder" and carries its placeholder; credentialId is a
 * label, not a Vault id. */
export async function capCliSubstitutions(env: Pick<E2BSandboxEnv, "MAIN_MCP">, scope: RuntimeResourceScope): Promise<Substitution[]> {
  if (env.MAIN_MCP === undefined) return [];
  const resolved = await env.MAIN_MCP.resolveManagedCapCliEnvironment({ tenantId: scope.workspaceId, sessionId: scope.sessionId });
  if (resolved.type !== "found") return [];
  return placeholderSubstitutions(resolved.env, "cap_cli");
}

/** Publishes outputs into FILES_BUCKET through the R2 binding. Replaces the
 * Session's previous set; any failed put or delete rejects. `read` returns
 * the published set (seeds a new sandbox on the copy sync). */
export function createR2BindingOutputSink(bucket: Pick<R2Bucket, "list" | "get" | "put" | "delete">, keyPrefix: (scope: RuntimeResourceScope) => string): SandboxOutputSinkPort {
  return {
    async *read(input) {
      const prefix = keyPrefix(input.scope);
      let cursor: string | undefined;
      do {
        input.signal.throwIfAborted();
        const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
        for (const object of page.objects) {
          const logicalPath = object.key.slice(prefix.length);
          if (logicalPath === "" || logicalPath.endsWith("/")) continue;
          const body = await bucket.get(object.key);
          if (body === null) continue;
          yield [logicalPath, new Uint8Array(await body.arrayBuffer())] as const;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
    },
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
