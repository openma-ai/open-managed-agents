// Sandbox SDK v2 adapter for Cloudflare containers (design §0.1 / §0.2),
// over the @cloudflare/sandbox 1.0 primitives CloudflareSandbox already has.
// Native storage (R2 mounts at container start) and native egress (the
// outbound handler bound with setOutboundContext). SessionDO still drives
// CloudflareSandbox directly; this is the v2 composition of the same
// primitives.
//
// Restore points use ctx.container.snapshotContainer(): the complete filesystem,
// not a /workspace backup. Restore starts the container from its snapshot ID.
// Requires durable_object scheduling. Snapshots are image-version-bound and
// expire 30 days after creation/last restore; Cloudflare exposes no delete API.
// https://developers.cloudflare.com/containers/guides/snapshots/
// Environment cache uses separate per-workspace rootfs snapshots. Missing
// environment snapshots rebuild; missing Session snapshots fail closed.

import { SandboxGoneError, type ResumeRef, type SandboxHandle, type SandboxLifecyclePort, type SandboxPlan } from "@open-managed-agents/sandbox";
import { parseExecResult } from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import type { SandboxAdapterPort } from "@open-managed-agents/sandbox-port-kit/ports";
import type { CloudflareSandbox } from "./sandbox";

/** The CloudflareSandbox surface this adapter uses. */
export type CloudflareSandboxRuntime = Pick<
  CloudflareSandbox,
  | "describeSandbox" | "provisionSandbox" | "createContainerSnapshot"
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

/** Workers RPC preserves the provider error message but not its class. Keep
 * the provider's confirmed loss as SandboxGoneError so Session runtime enters
 * its lost-sandbox recovery path instead of treating it as a model failure. */
export function isCloudflareSandboxNotRunningError(error: unknown): boolean {
  for (let current = error, depth = 0; current !== null && depth < 8; depth += 1) {
    if (typeof current === "object") {
      const candidate = current as { name?: unknown; message?: unknown; cause?: unknown };
      if (candidate.name === "SandboxNotRunningError" || String(candidate.message ?? "").includes("SANDBOX_NOT_RUNNING")) return true;
      current = candidate.cause;
    } else {
      return String(current).includes("SANDBOX_NOT_RUNNING");
    }
  }
  return false;
}

async function runtimeCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isCloudflareSandboxNotRunningError(error)) {
      throw new SandboxGoneError("Cloudflare sandbox is not running", { cause: error });
    }
    throw error;
  }
}

export function createCloudflareSandboxAdapter(input: {
  /** The DO-named sandbox of a Session: the handle is fixed. */
  sandbox(sessionId: string): CloudflareSandboxRuntime;
  /** Base URL the outbound handler calls back for credential egress. */
  controlPlaneBaseUrl?: string;
  /** The BACKUP_BUCKET binding: discard deletes backup objects here. */
  backups: Pick<R2Bucket, "delete">;
}): SandboxAdapterPort<CloudflareSandboxRuntime> {
  const sandboxFor = input.sandbox;
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
      // Keep a failed synchronous mount preflight on this acquire's awaited
      // rejection chain; detached adoption surfaces unhandled in Workerd.
      if (!("environmentSnapshot" in from)) return await provision(input.scope, input.plan);
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
      // Reusing a handle must not bypass managed persistence configuration.
      runtime.sessionOutputsMount({ tenantId: input.scope.workspaceId, sessionId: input.scope.sessionId });
      return (await runtime.describeSandbox()).running ? { runtime, handle: handleFor(input.scope) } : "gone";
    },

    /** The container's inactivity timeout is per deployment (OmaSandbox's
     * backstop, longer than the core's idle pause): `ttlMs` is ignored. */
    async keepAlive(input) {
      if (!(await input.runtime.describeSandbox()).running) return "gone";
      await input.runtime.renewActivityTimeout();
      return "alive";
    },

    async checkpoint(input): Promise<ResumeRef> {
      input.signal.throwIfAborted();
      const snapshot = await input.runtime.createContainerSnapshot();
      return { provider: "cloudflare", ref: snapshot.id, kind: "snapshot", metadata: { kind: "container" } };
    },

    async pause(input) {
      const ref = await lifecycle.checkpoint(input);
      await input.runtime.destroy();
      return ref;
    },

    /** Native start errors are surfaced; never restore only /workspace. */
    async resume(input) {
      input.signal.throwIfAborted();
      if (input.ref.provider !== "cloudflare" || input.ref.kind !== "snapshot" || input.ref.metadata?.kind !== "container") return "gone";
      return provision(input.scope, input.plan, { id: input.ref.ref });
    },

    async release(input) {
      await sandboxFor(input.handle.runtimeId).destroy();
    },

    /** Native snapshots have no delete API and wait for expiry. */
    async discard() {},

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
          await runtimeCall(() => runtime.writeFileBytes(path, new TextEncoder().encode(opts.stdin)));
          command = `(${cmd}) < ${path}; s=$?; rm -f ${path}; exit $s`;
        }
        return parseExecResult(await runtimeCall(() => runtime.exec(command, opts?.timeoutMs)));
      },
      /** base64 over exec (the shim's file API is text-only). */
      async readFile(runtime, path) {
        const quoted = `'${path.replaceAll("'", "'\\''")}'`;
        const result = parseExecResult(await runtimeCall(() => runtime.exec(`if [ -e ${quoted} ]; then base64 -w0 -- ${quoted}; else exit 44; fi`, 60_000)));
        if (result.exitCode === 44) return null;
        if (result.exitCode !== 0) throw new Error(`Reading ${path} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`);
        return Uint8Array.from(atob(result.stdout.trim()), (char) => char.charCodeAt(0));
      },
      async writeFile(runtime, path, bytes) {
        await runtimeCall(() => runtime.writeFileBytes(path, bytes));
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
