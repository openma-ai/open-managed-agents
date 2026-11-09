// Sandbox SDK v2 adapter for Cloudflare containers (design §0.1 / §0.2),
// over the @cloudflare/sandbox 1.0 primitives CloudflareSandbox already has.
// Native storage (R2 mounts at container start) and native egress (the
// outbound handler bound with setOutboundContext). SessionDO still drives
// CloudflareSandbox directly; this is the v2 composition of the same
// primitives.
//
// Restore points are /workspace backups (DirectoryBackup in OmaSandbox,
// objects in BACKUP_BUCKET under backups/); discard deletes their objects.
//
// Environment snapshots (environment cache) are container snapshots
// (ctx.container.snapshotContainer, durable_object scheduling policy): the
// whole root filesystem, without mounts, memory, processes or /run. Measured
// to restore in another Durable Object. The ref is the snapshot id. A missing
// one does not fail start(); OmaSandbox reports SNAPSHOT_GONE from the
// container monitor and acquire returns "gone". A snapshot of an older image
// still starts that older image, so the host's cache key carries the image
// digest. There is no delete API: deleteEnvironmentSnapshot is left out and
// snapshots expire after 30 days without a restore (each restore renews it).
//
// Gaps (§0.3): pause = workspace backup + destroy; the idle timeout is per deployment
// (OmaSandbox reads SANDBOX_IDLE_TIMEOUT_MS; plan.idleMs is not applied per
// sandbox); there is no runtime firewall, so a limited policy is enforced
// only on traffic the outbound handler sees; revoke reuses the handler's
// deny binding.

import type { ResumeRef, SandboxHandle, SandboxLifecyclePort, SandboxPlan } from "@open-managed-agents/sandbox";
import { parseExecResult } from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import type { SandboxAdapterPort } from "@open-managed-agents/sandbox-port-kit/ports";
import type { CloudflareSandbox } from "./sandbox";

/** The CloudflareSandbox surface this adapter uses. */
export type CloudflareSandboxRuntime = Pick<
  CloudflareSandbox,
  | "describeSandbox" | "provisionSandbox" | "createWorkspaceBackup" | "restoreWorkspaceBackup"
  | "memoryStoreMount" | "sessionOutputsMount" | "setOutboundContext" | "revokeOutboundContext"
  | "destroy" | "renewActivityTimeout" | "exec" | "writeFileBytes" | "setEnvVars"
  | "snapshotEnvironment" | "restrictOutboundToHosts"
>;

/** The adapter name in environment snapshot refs and cache keys. */
export const CLOUDFLARE_ADAPTER = "cloudflare";
/** Container snapshots expire 30 days after creation or their last restore. */
export const CLOUDFLARE_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** OmaSandbox OMA_SANDBOX_SNAPSHOT_GONE (Workers RPC keeps only the message). */
const SNAPSHOT_GONE = "SNAPSHOT_GONE";
export const isSnapshotGoneError = (error: unknown): boolean =>
  (error instanceof Error ? error.message : String(error)).includes(SNAPSHOT_GONE);

const BACKUP_TTL_SEC = 7 * 24 * 60 * 60;
/** OmaSandbox's DirectoryBackup storage: `{ binding: "BACKUP_BUCKET", prefix:
 * "backups/" }` (oma-sandbox.ts), archive key `<prefix><id>.tar.zst`
 * (@cloudflare/sandbox DirectoryBackupRecord), expiry sidecar
 * `backups/<id>.meta.json` (oma-sandbox.ts metaKey). */
export const backupObjectKeys = (id: string) => [`backups/${id}.tar.zst`, `backups/${id}.meta.json`];

export function createCloudflareSandboxAdapter(input: {
  /** The DO-named sandbox of a Session: the handle is fixed. */
  sandbox(sessionId: string): CloudflareSandboxRuntime;
  /** Base URL the outbound handler calls back for credential egress. */
  controlPlaneBaseUrl?: string;
  /** The BACKUP_BUCKET binding: discard deletes backup objects here. */
  backups: Pick<R2Bucket, "delete">;
}): SandboxAdapterPort<CloudflareSandboxRuntime> {
  const sandboxFor = input.sandbox;
  const backups = input.backups;
  const handleFor = (scope: RuntimeResourceScope): SandboxHandle => ({ provider: "cloudflare", runtimeId: scope.sessionId });
  const mountsFor = (runtime: CloudflareSandboxRuntime, scope: RuntimeResourceScope, plan: SandboxPlan) => {
    const outputs = runtime.sessionOutputsMount({ tenantId: scope.workspaceId, sessionId: scope.sessionId });
    return [
      ...(outputs === null ? [] : [outputs]),
      ...plan.stores.map((store) => runtime.memoryStoreMount(store)),
    ];
  };
  const provision = async (scope: RuntimeResourceScope, plan: SandboxPlan, containerSnapshot?: { id: string }) => {
    const runtime = sandboxFor(scope.sessionId);
    await runtime.provisionSandbox({
      incarnation: crypto.randomUUID().slice(0, 12),
      mounts: mountsFor(runtime, scope, plan),
      autoStart: false,
      ...(containerSnapshot === undefined ? {} : { containerSnapshot }),
    });
    return { runtime, handle: handleFor(scope) };
  };

  const lifecycle: SandboxLifecyclePort<CloudflareSandboxRuntime> = {
    handle: "fixed",
    /** Containers have no continuous-run cap. */
    maxLifetimeMs: null,

    /** From the deployment image, or from an environment snapshot: a
     * snapshot that is gone is "gone" at once (no retries); the core then
     * drops its record, warns, starts from the image and rebuilds. */
    async acquire(input) {
      input.signal.throwIfAborted();
      const from = input.plan.from;
      if (!("environmentSnapshot" in from)) return provision(input.scope, input.plan);
      const snapshot = from.environmentSnapshot;
      if (snapshot.adapter !== CLOUDFLARE_ADAPTER) {
        throw new Error(`The Cloudflare container adapter cannot start from a ${snapshot.adapter} environment snapshot`);
      }
      try {
        return await provision(input.scope, input.plan, { id: snapshot.ref });
      } catch (error) {
        if (isSnapshotGoneError(error)) return "gone";
        throw error;
      }
    },

    /** A stopped container would restart without its mounts: report gone so
     * the core resumes it with the full mount set. */
    async attach(input) {
      input.signal.throwIfAborted();
      const runtime = sandboxFor(input.scope.sessionId);
      return (await runtime.describeSandbox()).running ? { runtime, handle: handleFor(input.scope) } : "gone";
    },

    async keepAlive(input) {
      if (!(await input.runtime.describeSandbox()).running) return "gone";
      await input.runtime.renewActivityTimeout();
      return "alive";
    },

    async checkpoint(input): Promise<ResumeRef> {
      input.signal.throwIfAborted();
      const backup = await input.runtime.createWorkspaceBackup({ ttlSec: BACKUP_TTL_SEC });
      return backup === null
        ? { provider: "cloudflare", ref: input.handle.runtimeId, metadata: { kind: "self" } }
        : { provider: "cloudflare", ref: backup.id, metadata: { kind: "backup", backup: JSON.stringify(backup) } };
    },

    async pause(input) {
      const ref = await lifecycle.checkpoint(input);
      await input.runtime.destroy();
      return ref;
    },

    async resume(input) {
      const acquired = await provision(input.scope, input.plan);
      const raw = input.ref.metadata?.backup;
      if (typeof raw !== "string") return acquired;
      const restored = await acquired.runtime.restoreWorkspaceBackup(JSON.parse(raw));
      if (restored.ok) return acquired;
      await acquired.runtime.destroy();
      return "gone";
    },

    async release(input) {
      await sandboxFor(input.handle.runtimeId).destroy();
    },

    /** Backups: delete their objects (deleting a missing key succeeds). A
     * ref to the sandbox itself is a no-op. */
    async discard(input) {
      if (input.ref.provider !== "cloudflare" || input.ref.metadata?.kind !== "backup") return;
      await backups.delete(backupObjectKeys(input.ref.ref));
    },


    /** Snapshot the build sandbox's root filesystem; its mounts, memory and
     * processes are not in it. No deleteEnvironmentSnapshot: Containers has
     * no delete API, snapshots expire on their own. */
    async snapshotEnvironment(input) {
      input.signal.throwIfAborted();
      const snapshot = await input.runtime.snapshotEnvironment({ name: `oma-env-${input.handle.runtimeId}`.slice(0, 63) });
      if (typeof snapshot.id !== "string" || snapshot.id.length === 0) throw new Error("The container snapshot returned no id");
      return { adapter: CLOUDFLARE_ADAPTER, ref: snapshot.id };
    },

    /** Fixed handles: a rebuild reuses the DO name, so there are no orphans. */
    async list() {
      return [];
    },
  };
  return {
    name: CLOUDFLARE_ADAPTER,
    lifecycle,
    vendor: {
      sandboxIdentity: async runtime => {
        const incarnation = (await runtime.describeSandbox()).incarnation;
        if (!incarnation) throw new Error("Sandbox token requires a physical container incarnation");
        return incarnation;
      },
      async exec(runtime, cmd, opts) {
        let command = cmd;
        if (opts?.stdin !== undefined) {
          const path = `/tmp/.oma-stdin-${crypto.randomUUID()}`;
          await runtime.writeFileBytes(path, new TextEncoder().encode(opts.stdin));
          command = `(${cmd}) < ${path}; s=$?; rm -f ${path}; exit $s`;
        }
        return parseExecResult(await runtime.exec(command, opts?.timeoutMs));
      },
      /** base64 over exec (the shim's file API is text-only). */
      async readFile(runtime, path) {
        const quoted = `'${path.replaceAll("'", "'\\''")}'`;
        const result = parseExecResult(await runtime.exec(`if [ -e ${quoted} ]; then base64 -w0 -- ${quoted}; else exit 44; fi`, 60_000));
        if (result.exitCode === 44) return null;
        if (result.exitCode !== 0) throw new Error(`Reading ${path} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
        return Uint8Array.from(atob(result.stdout.trim()), (char) => char.charCodeAt(0));
      },
      async writeFile(runtime, path, bytes) {
        await runtime.writeFileBytes(path, bytes);
      },
      setEnv: (runtime, env) => runtime.setEnvVars(env),
    },
    native: {
      /** R2 mounts are attached when the container starts (acquire/resume
       * from the plan); attach only verifies them. Mounts are live, so sync
       * and detach have nothing to do. */
      storage: () => ({
        async attach(input) {
          const described = await input.runtime.describeSandbox();
          const wanted = ["/mnt/session/outputs", ...input.stores.map((store) => `/mnt/memory/${store.storeName}`)];
          const missing = wanted.filter((path) => !described.mounts.includes(path));
          if (missing.length > 0) throw new Error(`Cloudflare sandbox started without mounts: ${missing.join(", ")}`);
          await input.runtime.setEnvVars({ OMA_OUTPUTS_DIR: "/mnt/session/outputs" });
        },
        async sync() {},
        async detach() {},
      }),
      egress: () => ({
        port: {
          async attach(egress) {
            egress.signal.throwIfAborted();
            await egress.runtime.setOutboundContext({
              tenantId: egress.scope.workspaceId,
              environmentId: egress.scope.environmentId,
              sessionId: egress.scope.sessionId,
              workId: egress.scope.workId,
              // No sandbox token here: a required binding without one lets
              // nothing out (SessionDO binds the token: cloudflare-session-sandbox).
              required: true,
              ...(input.controlPlaneBaseUrl === undefined ? {} : { controlPlaneBaseUrl: input.controlPlaneBaseUrl }),
            });
          },
          async update(egress) {
            await egress.runtime.setOutboundContext({
              tenantId: egress.scope.workspaceId,
              environmentId: egress.scope.environmentId,
              sessionId: egress.scope.sessionId,
              workId: egress.scope.workId,
              // No sandbox token here: a required binding without one lets
              // nothing out (SessionDO binds the token: cloudflare-session-sandbox).
              required: true,
              ...(input.controlPlaneBaseUrl === undefined ? {} : { controlPlaneBaseUrl: input.controlPlaneBaseUrl }),
            });
          },
          async revoke(egress) {
            await egress.runtime.revokeOutboundContext({
              workId: egress.scope.workId,
              generation: egress.fence.generation,
              reason: egress.reason === "checkpoint" ? "completed" : egress.reason,
            });
          },
        },
      }),
    },
  };
}
