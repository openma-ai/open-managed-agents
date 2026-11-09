// Sandbox SDK v2 on Cloudflare containers for SessionDO (the default,
// SANDBOX_ADAPTER unset or "cloudflare").
//
// Composition only: createSandboxPorts + createCloudflareSandboxAdapter, handed
// to the shared Session runtime (session-sandbox.ts). The handle is "fixed":
// one Sandbox Durable Object per SessionDO, so state is derived, never stored.
// Restore points are the existing D1 workspace backups (workspace-backups.ts)
// that OmaSandbox writes when it backs up and stops an idle or destroyed
// container.
//
// Two deliberate differences from the adapter defaults:
//   - egress binds the outbound handler to the Session execution attempt
//     (design §0.0 rule 10), not to a runtime-resource fence: main checks the
//     attempt live (sandbox-gateway). With no attempt the binding carries
//     none and gets no Vault; revoke rebinds it that way.
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
import { log, logWarn } from "@open-managed-agents/shared";
import { buildCfTenantDbProvider, getCfServicesForTenant } from "@open-managed-agents/services";
import { CloudflareSandbox, type CloudflareSandboxImage } from "./sandbox";
import { createCloudflareSandboxAdapter, type CloudflareSandboxRuntime } from "./cloudflare-sandbox-ports";
import { loadManagedSessionResources } from "./managed-session-resources";
import { findLatestBackup, type WorkspaceBackupHandle } from "./workspace-backups";
import { memoryStoreMountTarget, PortsSessionSandbox, type SessionEnvironmentCache } from "@open-managed-agents/session-runtime";
import {
  createCloudflareEnvironmentCache,
  d1EnvironmentCacheStore,
  isEnvironmentBuildId,
  UNKNOWN_SANDBOX_IMAGE,
  type CloudflareEnvironmentSetup,
} from "./cloudflare-environment-cache";

export interface CloudflareSessionSandboxDeps {
  env: Env;
  /** Sandbox Durable Object name (the SessionDO id, 1-63 chars). */
  sandboxId: string;
  /** Operator catalog image (container binding + workdir); null = SANDBOX. */
  sandboxImage: CloudflareSandboxImage | null;
  session(): { tenantId: string; environmentId: string; sessionId: string; agentId: string | null };
  /** The Session's current execution attempt (SessionDO's fence); undefined between turns. */
  fence(): SandboxExecutionFence | undefined;
  warn(message: string): void;
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

const IDLE_MS = 5 * 60_000;
const START_ATTEMPTS = 3;

export function createCloudflareSessionSandbox(deps: CloudflareSessionSandboxDeps): PortsSessionSandbox<CloudflareSandboxRuntime> {
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
        native: { ...adapter.native, egress: () => ({ port: executionEgress(deps.session, deps.fence) }) },
      // Both are native, so the generic implementations' deps are never read.
      }, { storage: {} as never, egress: {} as never });
      return { ports };
    },
    executor: () => sandbox,
    state: {
      load: async () => ({ handle: handle(), stores: [], outputs: false }),
      save: async () => undefined,
      clear: async () => undefined,
    },
    scope,
    async plan({ scope: s, generation }) {
      const session = deps.session();
      return {
        from: { image: (await sandbox.sandboxImage().catch(() => null)) ?? UNKNOWN_SANDBOX_IMAGE },
        egress: null,
        stores: session.sessionId ? await managedStores(deps.env, session, generation) : [],
        outputs: { bindingId: `outputs:${s.sessionId}`, mountPath: "/mnt/session/outputs" },
        idleMs: IDLE_MS,
        labels: { workspaceId: s.workspaceId, sessionId: s.sessionId },
      };
    },
    async resumeRef() {
      const backup = await latestBackup(deps.env, deps.session());
      return backup === null ? null : { provider: "cloudflare", ref: backup.id, metadata: { kind: "backup", backup: JSON.stringify(backup) } };
    },
    warn: deps.warn,
    outputDurability: () => sandbox.sessionOutputMountCapabilities(),
    // The outbound handler holds no expiring credential; it is rebound when
    // the execution attempt changes. The attempt is the Port fence (design
    // §0.0 rule 10); the one SessionDO holds now is the current one.
    egressRenewMs: null,
    execution: () => deps.fence?.(),
    isCurrent: async (execution) => execution === undefined || sandboxExecutionFenceKey(deps.fence?.()) === sandboxExecutionFenceKey(execution),
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

/** Binds what OmaSandbox's idle teardown needs, after every acquire /
 * attach / resume; retries a failed container start. */
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

function executionEgress(
  session: CloudflareSessionSandboxDeps["session"],
  fence: CloudflareSessionSandboxDeps["fence"],
): SandboxEgressPort<CloudflareSandboxRuntime> {
  const bind = async (runtime: CloudflareSandboxRuntime, current: SandboxExecutionFence | undefined) => {
    const s = session();
    if (!s.sessionId || !s.tenantId) return;
    await runtime.setOutboundContext({
      tenantId: s.tenantId, sessionId: s.sessionId,
      ...(current === undefined ? {} : { executionId: current.executionId, attemptId: current.attemptId, ownerId: current.ownerId, generation: current.generation }),
    });
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

/** Latest workspace backup of this Session; none when a github_repository
 * clones into /workspace (git clone needs it empty). Best effort, as before. */
async function latestBackup(
  env: Env,
  session: { tenantId: string; environmentId: string; sessionId: string },
): Promise<WorkspaceBackupHandle | null> {
  if (!session.tenantId || !session.environmentId || !env.MAIN_DB) return null;
  try {
    if (session.sessionId) {
      const services = await getCfServicesForTenant(env, session.tenantId);
      const rows = await services.sessions.listResourcesBySession({ sessionId: session.sessionId });
      if (rows.some((r) => r.type === "github_repository" || r.type === "github_repo")) {
        logWarn({ op: "session_do.warmup.skip_restore_github_repo", session_id: session.sessionId }, "skipping workspace restore — session attaches github_repository (git clone needs empty /workspace)");
        return null;
      }
    }
    const db = await buildCfTenantDbProvider(env).resolve(session.tenantId);
    const backup = await findLatestBackup(db, session.tenantId, session.environmentId, session.sessionId || "unknown", Date.now());
    if (backup === null) {
      log({ op: "session_do.warmup.no_backup", session_id: session.sessionId, tenant_id: session.tenantId, environment_id: session.environmentId }, "no workspace backup found for this session — starting fresh");
    }
    return backup;
  } catch (err) {
    logWarn({ op: "session_do.warmup.restore_backup", session_id: session.sessionId, err }, "workspace backup lookup failed; continuing with empty /workspace");
    return null;
  }
}
