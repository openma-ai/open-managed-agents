// Sandbox SDK v2 on E2B for the Cloudflare control plane (SANDBOX_ADAPTER=e2b).
//
// Composition only: createSandboxPorts + createE2BV2Adapter, handed to the
// shared Session runtime (session-sandbox.ts):
//   - the handle lives in DO storage ("changes" handle);
//   - egress is the provider firewall from the Environment networking (no
//     Vault substitutions on this path);
//   - Memory Stores are s3fs mounts with prefix-scoped temporary R2
//     credentials minted here from the memory-bucket key (the key itself
//     never enters the sandbox);
//   - /mnt/session/outputs is copied out at turn end into FILES_BUCKET
//     through the R2 binding (best effort, not a live mount).

import type {
  EgressPolicy,
  MemoryStoreBinding,
  SandboxHandle,
  SandboxPlan,
  SandboxPorts,
} from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { createSandboxPorts, type SandboxOutputSinkPort, type SandboxVendorPort } from "@open-managed-agents/sandbox-port-kit";
import { createR2TemporaryCredentials } from "@open-managed-agents/sandbox-port-kit/object-storage";
import { createE2BV2Adapter, type E2BV2Module } from "@open-managed-agents/sandbox-adapter-e2b/v2";
import type { E2BSandboxExecutor } from "@open-managed-agents/sandbox-adapter-e2b";
import { sessionOutputsPrefix } from "@open-managed-agents/shared";
import { PortsSessionSandbox, type SessionSandboxExecutor } from "./session-sandbox";

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
