// Sandbox SDK v2 on Cloudflare containers for SessionDO (the default,
// SANDBOX_ADAPTER unset or "cloudflare").
//
// Composition only: createSandboxPorts + createCloudflareSandboxAdapter, handed
// to the shared Session runtime (session-sandbox.ts). The handle is "fixed":
// one Sandbox Durable Object per SessionDO, so a Session with no record yet
// starts from a running record naming it (attach is tried first, as a
// container may outlive its record). The record is kept in SessionDO storage,
// every write a compare-and-set on its version (session-sandbox-do-state).
// Recovery points live only in the version-CAS Session sandbox record.
// D1 workspace backups are not container snapshots and never override it.
//
// Two deliberate differences from the adapter defaults:
//   - egress binds the outbound handler to the Session execution attempt
//     (design §0.0 rule 10), not to a runtime-resource fence: main checks the
//     attempt live (sandbox-gateway). With no attempt the binding carries
//     none and gets no Vault; revoke rebinds it that way.
//   - acquire / resume keep the 3-attempt container start retry and bind the
//     backup and billing context OmaSandbox needs for its idle teardown.

import type { MemoryStoreBinding, SandboxLifecyclePort } from "@open-managed-agents/sandbox";
import { createSandboxPorts } from "@open-managed-agents/sandbox-port-kit";
import type { SandboxEgressPort } from "@open-managed-agents/sandbox";
import type { Env } from "@open-managed-agents/shared";
import { CloudflareSandbox, type CloudflareSandboxImage } from "./sandbox";
import { createCloudflareSandboxAdapter, type CloudflareSandboxRuntime } from "./cloudflare-sandbox-ports";
import { loadManagedSessionResources } from "./managed-session-resources";
import { durableObjectSandboxState, type SessionSandboxStateStorage } from "./session-sandbox-do-state";
import { initialSandboxState, memoryStoreMountTarget, PortsSessionSandbox, type SessionSandboxIdleTimer } from "@open-managed-agents/session-runtime";

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
  warn(message: string): void;
  /** Schedules the core's idle pause (design §0.0 rule 11); `pauseMs` = IDLE_MS. */
  idleTimer: Omit<SessionSandboxIdleTimer, "pauseMs">;
}

/** What the outbound binding needs of a SessionExecutionFence. */
export interface SandboxExecutionFence { executionId: string; attemptId: string; ownerId: string; generation: number }
export const sandboxExecutionFenceKey = (fence: SandboxExecutionFence | undefined): string =>
  fence === undefined ? "" : `${fence.executionId}/${fence.attemptId}/${fence.ownerId}/${fence.generation}`;

/** idlePauseMs; OmaSandbox's idle backstop (OMA_SANDBOX_IDLE_TIMEOUT_MS) is longer. */
const IDLE_MS = 5 * 60_000;
const START_ATTEMPTS = 3;
const STATE_KEY = "cloudflare_sandbox_state";

export function createCloudflareSessionSandbox(deps: CloudflareSessionSandboxDeps): PortsSessionSandbox<CloudflareSandboxRuntime> {
  const sandbox = new CloudflareSandbox(deps.env, deps.sandboxId, deps.sandboxImage);
  const scope = () => {
    const s = deps.session();
    return { workspaceId: s.tenantId, environmentId: s.environmentId, sessionId: s.sessionId, workId: s.sessionId };
  };
  const handle = () => ({ provider: "cloudflare", runtimeId: deps.session().sessionId });
  return new PortsSessionSandbox<CloudflareSandboxRuntime>({
    async compose() {
      // One Sandbox DO per SessionDO: the adapter's sessionId argument names
      // the same sandbox.
      const adapter = createCloudflareSandboxAdapter({ sandbox: () => sandbox, backups: backupBucket(deps.env) });
      const { ports } = createSandboxPorts({
        ...adapter,
        lifecycle: withSessionContext(adapter.lifecycle, sandbox, deps.session),
        native: { ...adapter.native, egress: () => ({ port: executionEgress(deps.session, deps.fence) }) },
      // Both are native, so the generic implementations' deps are never read.
      }, { storage: {} as never, egress: {} as never });
      return { ports };
    },
    executor: () => sandbox,
    state: (() => {
      const stored = durableObjectSandboxState(deps.storage, STATE_KEY);
      // No record yet: this Session's Sandbox DO, whose container may be running.
      return { ...stored, load: async () => (await stored.load()) ?? { ...initialSandboxState(), phase: "running", handle: handle(), runStartedAt: 0 } };
    })(),
    scope,
    async plan({ scope: s, generation }) {
      const session = deps.session();
      return {
        from: { image: "deployment" },
        egress: null,
        stores: session.sessionId ? await managedStores(deps.env, session, generation) : [],
        outputs: { bindingId: `outputs:${s.sessionId}`, mountPath: "/mnt/session/outputs" },
        idleMs: IDLE_MS,
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
    idle: { pauseMs: IDLE_MS, ...deps.idleTimer },
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

