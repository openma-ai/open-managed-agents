// Sandbox SDK v2 adapter for Cloudflare containers (design §0.1 / §0.2),
// over the @cloudflare/sandbox 1.0 primitives CloudflareSandbox already has.
// Native storage (R2 mounts at container start) and native egress (the
// outbound handler bound with setOutboundContext). SessionDO still drives
// CloudflareSandbox directly; this is the v2 composition of the same
// primitives.
//
// Restore points and templates are /workspace backups (DirectoryBackup in
// OmaSandbox, objects in BACKUP_BUCKET under backups/). A backup restores
// into any sandbox of this deployment, so it also serves as a 1:n template;
// discard deletes its objects through the binding.
//
// Gaps (§0.3): no rootfs snapshot API in Sandbox SDK 1.0, so a template
// holds only /workspace (setup that installs outside it is not captured) and
// pause = workspace backup + destroy; the idle timeout is per deployment
// (OmaSandbox reads SANDBOX_IDLE_TIMEOUT_MS; plan.idleMs is not applied per
// sandbox); there is no runtime firewall, so a limited policy is enforced
// only on traffic the outbound handler sees; revoke reuses the handler's
// deny binding.

import type { ResumeRef, SandboxHandle, SandboxLifecyclePort, SandboxPlan, TemplateRef } from "@open-managed-agents/sandbox";
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
>;

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
  const provision = async (scope: RuntimeResourceScope, plan: SandboxPlan) => {
    const runtime = sandboxFor(scope.sessionId);
    await runtime.provisionSandbox({ incarnation: crypto.randomUUID().slice(0, 12), mounts: mountsFor(runtime, scope, plan), autoStart: false });
    return { runtime, handle: handleFor(scope) };
  };

  const lifecycle: SandboxLifecyclePort<CloudflareSandboxRuntime> = {
    handle: "fixed",
    /** Containers have no continuous-run cap. */
    maxLifetimeMs: null,

    /** From the deployment image, or from a template: provision, then
     * restore its /workspace backup. An expired or deleted template → "gone". */
    async acquire(input) {
      input.signal.throwIfAborted();
      const acquired = await provision(input.scope, input.plan);
      if (!("template" in input.plan.from)) return acquired;
      const raw = input.plan.from.template.metadata?.backup;
      if (input.plan.from.template.provider !== "cloudflare" || typeof raw !== "string") {
        await acquired.runtime.destroy();
        throw new Error("Cloudflare adapter received a template it did not create");
      }
      const restored = await acquired.runtime.restoreWorkspaceBackup(JSON.parse(raw));
      if (restored.ok) return acquired;
      await acquired.runtime.destroy();
      return "gone";
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

    /** Backups and templates: delete their objects (deleting a missing key
     * succeeds). A ref to the sandbox itself is a no-op. */
    async discard(input) {
      const kind = input.ref.metadata?.kind;
      if (input.ref.provider !== "cloudflare" || (kind !== "backup" && kind !== "template")) return;
      await backups.delete(backupObjectKeys(input.ref.ref));
    },

    /** A /workspace backup of the build sandbox. Restores into any sandbox of
     * the deployment (1:n); it does not capture the rootfs. */
    async snapshotTemplate(input): Promise<TemplateRef> {
      input.signal.throwIfAborted();
      const backup = await input.runtime.createWorkspaceBackup({ name: "template", ttlSec: BACKUP_TTL_SEC });
      if (backup === null) throw new Error("Cloudflare template backup produced no archive");
      return { provider: "cloudflare", ref: backup.id, metadata: { kind: "template", backup: JSON.stringify(backup) } };
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
