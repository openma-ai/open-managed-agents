// Sandbox SDK v2 on Cloudflare containers for SessionDO (the default,
// SANDBOX_ADAPTER unset or "cloudflare").
//
// Composition only: createSandboxPorts + createCloudflareSandboxAdapter, handed
// to the shared Session runtime (session-sandbox.ts). The handle is "fixed":
// one Sandbox Durable Object per SessionDO. With no record, only a live
// container starts from an attachable running record (it may outlive its
// record); a stopped one starts fresh. The record is kept in SessionDO storage,
// every write a compare-and-set on its version (session-sandbox-do-state).
// Recovery points live only in the version-CAS Session sandbox record.
// D1 workspace backups are not container snapshots and never override it.
//
// Two deliberate differences from the adapter defaults:
//   - egress binds the outbound handler to the Session execution attempt's
//     sandbox token (design §0.0 rule 10, #561; its digest, the binding is
//     stored), the one an in-sandbox ACP harness also holds: main checks it
//     live (sandbox-gateway), as for the E2B / Node relay. With no attempt the
//     binding carries none and gets no Vault; revoke rebinds it that way.
//   - acquire / resume keep the 3-attempt container start retry and bind the
//     backup and billing context OmaSandbox needs for its idle teardown.
//
// Environment cache (cloudflare-environment-cache.ts): plan.from.image is
// the Sandbox class's digest-pinned image. A build sandbox is its own Sandbox
// Durable Object named by the build id, without the Session's outputs.

import type { EnvironmentPackages, MemoryStoreBinding, SandboxLifecyclePort } from "@open-managed-agents/sandbox";
import { createSandboxPorts } from "@open-managed-agents/sandbox-port-kit";
import type { SandboxEgressPort } from "@open-managed-agents/sandbox";
import type { Env } from "@open-managed-agents/shared";
import { sandboxTokenSha256, type SessionExecutionAttemptRef } from "@open-managed-agents/sandbox-gateway";
import { buildCfTenantDbProvider } from "@open-managed-agents/services";
import { CloudflareSandbox, type CloudflareSandboxImage } from "./sandbox";
import { LegacySandboxTokenUnavailable } from "./sandbox-token-rpc-error";
import { createCloudflareSandboxAdapter, type CloudflareSandboxRuntime } from "./cloudflare-sandbox-ports";
import { loadManagedSessionResources } from "./managed-session-resources";
import { sandboxIdlePauseMs, initialSandboxState, memoryStoreMountTarget, PortsSessionSandbox, type SessionSandboxIdleTimer, type SessionEnvironmentCache } from "@open-managed-agents/session-runtime";
import {
  createCloudflareEnvironmentCache,
  d1EnvironmentCacheStore,
  isEnvironmentBuildId,
  UNKNOWN_SANDBOX_IMAGE,
  type CloudflareEnvironmentSetup,
} from "./cloudflare-environment-cache";
import { durableObjectSandboxState, type SessionSandboxStateStorage } from "./session-sandbox-do-state";

export interface CloudflareSessionSandboxDeps {
  env: Env;
  /** Sandbox Durable Object name (the SessionDO id, 1-63 chars). */
  sandboxId: string;
  /** Operator catalog image (container binding + workdir); null = SANDBOX. */
  sandboxImage: CloudflareSandboxImage | null;
  /** Where the handle record lives (SessionDO storage). */
  storage: SessionSandboxStateStorage;
  session(): { tenantId: string; environmentId: string; sessionId: string; agentId: string | null };
  /** The Session's current execution attempt (SessionDO's fence); undefined between turns. */
  fence(): SandboxExecutionFence | undefined;
  /** The sandbox token for one egress binding of `attempt` (#561). */
  relayToken(attempt: SessionExecutionAttemptRef, sandbox?: object | string): Promise<string>;
  warn(message: string): void;
  /** Schedules the core's idle pause (design §0.0 rule 11); `pauseMs` = IDLE_MS. */
  idleTimer: Omit<SessionSandboxIdleTimer, "pauseMs">;
  /** The Session's Environment config now (environment cache); omitted = cache off. */
  environmentConfig?(): Promise<{ config?: { packages?: EnvironmentPackages } } | null>;
  /** The Durable Object's waitUntil, for the background environment snapshot build. */
  waitUntil?(promise: Promise<unknown>): void;
}

/** An environment snapshot build sandbox: never mounts a Session's outputs. */
class BuildSandbox extends CloudflareSandbox {
  override sessionOutputsMount(): null { return null; }
}

/** What the outbound binding needs of a SessionExecutionFence. */
export interface SandboxExecutionFence { executionId: string; attemptId: string; ownerId: string; generation: number }
export const sandboxExecutionFenceKey = (fence: SandboxExecutionFence | undefined): string =>
  fence === undefined ? "" : `${fence.executionId}/${fence.attemptId}/${fence.ownerId}/${fence.generation}`;

/** idlePauseMs; OmaSandbox's idle backstop (OMA_SANDBOX_IDLE_TIMEOUT_MS) is longer. */
const START_ATTEMPTS = 3;
const STATE_KEY = "cloudflare_sandbox_state";

export function createCloudflareSessionSandbox(deps: CloudflareSessionSandboxDeps): PortsSessionSandbox<CloudflareSandboxRuntime> {
  const idleMs = sandboxIdlePauseMs((deps.env as { SANDBOX_IDLE_PAUSE_MS?: string }).SANDBOX_IDLE_PAUSE_MS);
  const sandbox = new CloudflareSandbox(deps.env, deps.sandboxId, deps.sandboxImage);
  const scope = () => {
    const s = deps.session();
    return { workspaceId: s.tenantId, environmentId: s.environmentId, sessionId: s.sessionId, workId: s.sessionId };
  };
  const handle = () => ({ provider: "cloudflare", runtimeId: deps.session().sessionId });
  // One Sandbox DO per SessionDO; an environment build sandbox is its own DO.
  const adapter = createCloudflareSandboxAdapter({
    sandbox: (id) => isEnvironmentBuildId(id) ? new BuildSandbox(deps.env, id, deps.sandboxImage) : sandbox,
    backups: backupBucket(deps.env),
  });
  const sessionLifecycle = withSessionContext(adapter.lifecycle, sandbox, deps.session);
  const environmentCache = cloudflareEnvironmentCache(deps, adapter.lifecycle, sessionLifecycle);
  return new PortsSessionSandbox<CloudflareSandboxRuntime>({
    async compose() {
      const { ports } = createSandboxPorts({
        ...adapter,
        lifecycle: sessionLifecycle,
        native: { ...adapter.native, egress: () => ({ port: executionEgress(deps), tokenBinding: "native" }) },
      }, { storage: {} as never, egress: { gateway: {
        endpoint: { url: deps.env.PUBLIC_BASE_URL ?? "https://unconfigured.invalid" },
        issueToken: ({ attempt, sandbox }) => {
          if (attempt === null) throw new Error("Sandbox token requires a running attempt");
          return deps.relayToken(attempt, sandbox);
        },
        authenticate: async () => null,
        handle: async () => new Response(null, { status: 404 }),
      } } });
      return { ports };
    },
    executor: () => sandbox,
    state: (() => {
      const stored = durableObjectSandboxState(deps.storage, STATE_KEY);
      // Probe only when no durable record exists. A live legacy container is
      // attachable; a stopped one is an initial create, not evidence of loss.
      return { ...stored, load: async () => (await stored.load()) ?? ((await sandbox.describeSandbox()).running
        ? { ...initialSandboxState(), phase: "running", handle: handle(), runStartedAt: 0 }
        : initialSandboxState()) };
    })(),
    scope,
    async plan({ scope: s, generation }) {
      const session = deps.session();
      return {
        from: { image: (await sandbox.sandboxImage().catch(() => null)) ?? UNKNOWN_SANDBOX_IMAGE },
        egress: null,
        stores: session.sessionId ? await managedStores(deps.env, session, generation) : [],
        outputs: { bindingId: `outputs:${s.sessionId}`, mountPath: "/mnt/session/outputs" },
        idleMs,
        labels: { workspaceId: s.workspaceId, sessionId: s.sessionId },
      };
    },
    resumeRef: async () => null,
    warn: deps.warn,
    outputDurability: () => sandbox.sessionOutputMountCapabilities(),
    // The outbound handler holds no expiring credential; it is rebound when
    // the execution attempt changes. The attempt is the Port fence (design
    // §0.0 rule 10); the one SessionDO holds now is the current one.
    egressRenewMs: null,
    execution: () => deps.fence?.(),
    isCurrent: async (execution) => sandboxExecutionFenceKey(deps.fence?.()) === sandboxExecutionFenceKey(execution),
    idle: { pauseMs: idleMs, ...deps.idleTimer },
    ...(environmentCache === undefined ? {} : { environmentCache }),
  });
}

/** Off without the Session's setup source or the tenant D1 (records). The
 * build sandbox goes through the adapter's own lifecycle: the Session's
 * backup and billing context belong to the Session's sandbox. */
function cloudflareEnvironmentCache(
  deps: CloudflareSessionSandboxDeps,
  lifecycle: SandboxLifecyclePort<CloudflareSandboxRuntime>,
  sessionLifecycle: SandboxLifecyclePort<CloudflareSandboxRuntime>,
): SessionEnvironmentCache<CloudflareSandboxRuntime> | undefined {
  const { environmentConfig, waitUntil } = deps;
  if (environmentConfig === undefined || waitUntil === undefined || !deps.env.MAIN_DB) return undefined;
  const environmentSetup = async (): Promise<CloudflareEnvironmentSetup | null> => {
    const environmentId = deps.session().environmentId;
    const packages = environmentId ? (await environmentConfig())?.config?.packages : undefined;
    return environmentId && packages ? { environmentId, packages } : null;
  };
  const dbFor = new Map<string, Promise<D1Database>>();
  const tenantDb = (workspaceId: string) => {
    let db = dbFor.get(workspaceId);
    if (db === undefined) dbFor.set(workspaceId, db = buildCfTenantDbProvider(deps.env).resolve(workspaceId) as Promise<D1Database>);
    return db;
  };
  return createCloudflareEnvironmentCache({
    lifecycle, sessionLifecycle,
    storeFor: (workspaceId) => ({
      retiredKeys: async (prefix, cursor, limit) => d1EnvironmentCacheStore(await tenantDb(workspaceId), workspaceId).retiredKeys(prefix, cursor, limit),
      compareAndSwap: async (key, expected, value) => d1EnvironmentCacheStore(await tenantDb(workspaceId), workspaceId).compareAndSwap(key, expected, value),
      get: async (key) => d1EnvironmentCacheStore(await tenantDb(workspaceId), workspaceId).get(key),
      put: async (key, value) => d1EnvironmentCacheStore(await tenantDb(workspaceId), workspaceId).put(key, value),
      delete: async (key) => d1EnvironmentCacheStore(await tenantDb(workspaceId), workspaceId).delete(key),
    }),
    setup: environmentSetup,
    warn: (warning) => deps.warn(`environment_cache_${warning.reason}: ${warning.message}`),
    waitUntil,
  });
}

/** BACKUP_BUCKET (OmaSandbox's DirectoryBackup binding), read when a backup
 * or template is discarded. */
function backupBucket(env: Env): Pick<R2Bucket, "delete"> {
  return {
    async delete(keys) {
      const bucket = (env as Env & { BACKUP_BUCKET?: R2Bucket }).BACKUP_BUCKET;
      if (bucket === undefined) throw new Error("BACKUP_BUCKET binding is unavailable");
      await bucket.delete(keys);
    },
  };
}

/** Binds billing/legacy backup context and retries container starts.
 * Snapshot publication belongs exclusively to the shared CAS core. */
function withSessionContext(
  lifecycle: SandboxLifecyclePort<CloudflareSandboxRuntime>,
  sandbox: CloudflareSandbox,
  session: CloudflareSessionSandboxDeps["session"],
 ): SandboxLifecyclePort<CloudflareSandboxRuntime> {
  const bind = async <T>(acquired: T): Promise<T> => {
    if (acquired === "gone") return acquired;
    const s = session();
    if (s.sessionId && s.tenantId && s.environmentId) {
      await sandbox.setBackupContext({ tenantId: s.tenantId, environmentId: s.environmentId, sessionId: s.sessionId });
    }
    if (s.sessionId && s.tenantId) await sandbox.setBillingContext({ tenantId: s.tenantId, sessionId: s.sessionId, agentId: s.agentId });
    return acquired;
  };
  return {
    ...lifecycle,
    acquire: async (input) => bind(await startWithRetry(() => lifecycle.acquire(input))),
    attach: async (input) => bind(await lifecycle.attach(input)),
    resume: async (input) => bind(await startWithRetry(() => lifecycle.resume(input))),
  };
}

async function startWithRetry<T>(start: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    try {
      return await start();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < START_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 5000)));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Sandbox container failed to start after ${START_ATTEMPTS} attempts. Last error: ${message}`);
}

/** A Session with no sandbox token (none issues: e.g. no managed Session
 * record) is bound without one and warned about: it gets no Vault, and a
 * request carrying a Vault placeholder is refused (oma-sandbox). */
export function executionEgress(deps: Pick<CloudflareSessionSandboxDeps, "session" | "fence" | "relayToken" | "warn">): SandboxEgressPort<CloudflareSandboxRuntime> {
  const { fence } = deps;
  const tokenFor = async (attempt: SessionExecutionAttemptRef, sandbox: string) => {
    try {
      const tokenSha256 = await sandboxTokenSha256(await deps.relayToken(attempt, sandbox));
      if (tokenSha256 === null) throw new Error("Sandbox token is malformed");
      return tokenSha256;
    } catch (error) {
      // Only a missing legacy Session may continue without credential egress.
      // Managed authorization, stale fences, malformed tokens and store errors
      // must fail the execution rather than become a no-token binding.
      if (!(error instanceof LegacySandboxTokenUnavailable)) throw error;
      deps.warn(`Vault and GitHub credentials are unavailable this execution: no sandbox token (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  };
  const bind = async (runtime: CloudflareSandboxRuntime, current: SandboxExecutionFence | undefined) => {
    const s = deps.session();
    if (!s.sessionId || !s.tenantId) return;
    const incarnation = current === undefined ? null : (await runtime.describeSandbox()).incarnation;
    if (current !== undefined && !incarnation) throw new Error("Sandbox token requires a physical container incarnation");
    const tokenSha256 = current === undefined ? null : await tokenFor({ workspaceId: s.tenantId, sessionId: s.sessionId, ...current }, incarnation!);
    await runtime.setOutboundContext({ tenantId: s.tenantId, sessionId: s.sessionId, ...(tokenSha256 === null ? {} : { tokenSha256 }) });
  };
  return {
    attach: ({ runtime }) => bind(runtime, fence?.()),
    update: ({ runtime }) => bind(runtime, fence?.()),
    revoke: ({ runtime }) => bind(runtime, undefined),
  };
}

/** Memory Stores must be in the plan: Sandbox SDK 1.0 mounts only at
 * container start. Their private copy is scoped to the generation. */
async function managedStores(
  env: Env,
  session: { tenantId: string; sessionId: string },
  generation: string,
): Promise<MemoryStoreBinding[]> {
  const source = env.MAIN_MCP;
  if (source === undefined) throw new Error("Managed Session input source service binding is unavailable");
  const loaded = await loadManagedSessionResources(source, { tenantId: session.tenantId, sessionId: session.sessionId, runtimeGeneration: generation });
  const stores: MemoryStoreBinding[] = [];
  for (const resource of loaded.resources) {
    if (resource.type !== "memory_store") continue;
    const target = memoryStoreMountTarget(resource);
    // An unnamed store fails later with the resource mounter's own error.
    if (target !== null) stores.push(target);
  }
  return stores;
}
