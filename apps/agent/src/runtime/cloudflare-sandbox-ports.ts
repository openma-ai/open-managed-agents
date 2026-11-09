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

import type { ResumeRef, SandboxHandle, SandboxLifecyclePort, SandboxPlan, TemplateRef } from "@open-managed-agents/sandbox";
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
>;

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
    await runtime.provisionSandbox({ incarnation: crypto.randomUUID().slice(0, 12), mounts: mountsFor(runtime, scope, plan), autoStart: false, ...(containerSnapshot === undefined ? {} : { containerSnapshot }) });
    return { runtime, handle: handleFor(scope) };
  };

  const lifecycle: SandboxLifecyclePort<CloudflareSandboxRuntime> = {
    handle: "fixed",
    /** Containers have no continuous-run cap. */
    maxLifetimeMs: null,

    /** Restore the full filesystem before attaching the planned mounts. */
    async acquire(input) {
      input.signal.throwIfAborted();
      if (!("template" in input.plan.from)) return provision(input.scope, input.plan);
      const template = input.plan.from.template;
      if (template.provider !== "cloudflare" || template.metadata?.kind !== "container") throw new Error("Cloudflare adapter received a template it did not create");
      return provision(input.scope, input.plan, { id: template.ref });
    },

    /** A stopped container would restart without its mounts: report gone so
     * the core resumes it with the full mount set. */
    async attach(input) {
      input.signal.throwIfAborted();
      const runtime = sandboxFor(input.scope.sessionId);
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

    /** No native delete API: unreferenced snapshots wait for the 30-day expiry. */
    async discard() {},

    async snapshotTemplate(input): Promise<TemplateRef> {
      input.signal.throwIfAborted();
      const snapshot = await input.runtime.createContainerSnapshot({ name: "template" });
      return { provider: "cloudflare", ref: snapshot.id, metadata: { kind: "container" } };
    },

    /** Fixed handles: a rebuild reuses the DO name, so there are no orphans. */
    async list() {
      return [];
    },
  };
  return {
    name: "cloudflare",
    lifecycle,
    vendor: {
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
              ownerId: egress.fence.ownerId,
              generation: egress.fence.generation,
              fenceToken: egress.fence.token,
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
              ownerId: egress.fence.ownerId,
              generation: egress.fence.generation,
              fenceToken: egress.fence.token,
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
