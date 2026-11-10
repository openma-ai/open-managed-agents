import type * as SDK from "@alibaba-group/opensandbox";
import { createOpenSandboxNativeEgress, revokeOpenSandboxVault } from "./native-egress";
import {
  RetryableSandboxError, SandboxGoneError,
  type Acquired, type SandboxHandle, type SandboxLifecyclePort, type SandboxPlan,
  type ResumeRef, type TemplateRef,
} from "@open-managed-agents/sandbox";
import { compileFirewall, type FirewallRules } from "@open-managed-agents/sandbox-port-kit/firewall";
import { SandboxAssemblyError, type SandboxAdapterPort, type SandboxVendorPort } from "@open-managed-agents/sandbox-port-kit/ports";
import { OpenSandbox, joinOutputLines, type OpenSandboxOptions } from "./opensandbox";
import { PLATFORM_ROOT, workspaceRootFromProbe } from "@open-managed-agents/sandbox";

type Scope = Parameters<SandboxLifecyclePort<OpenSandbox>["acquire"]>[0]["scope"];
/** OpenSandbox's SDK has domain rules, but no IP/CIDR enforcement and no
 * atomic full-policy replacement facade. The deployment supplies that missing
 * boundary (e.g. its network controller), not a boolean claiming enforcement.
 * Never implement this using only HTTP_PROXY or patchEgressRules: direct egress,
 * metadata IPs and removal of old grants must be covered too. */
export interface OpenSandboxNetworkPort {
  /** Validate/prepare all rules before any compute starts. Return the SDK
   * policy to apply at creation. Deployment-level hard denies must already
   * apply to every newly allocated sandbox, including restored snapshots. */
  prepare(rules: FirewallRules): Promise<SDK.NetworkPolicy>;
  /** Replace the complete policy, fail closed on any partial application.
   * Must enforce denyAlways/CIDRs as well as host rules, without retaining old
   * grants. Implementations must not return until enforcement is effective. */
  replace(client: SDK.Sandbox, rules: FirewallRules): Promise<void>;
}

export interface OpenSandboxV2Options {
  sdk: typeof SDK;
  options: OpenSandboxOptions;
  /** Stable non-secret namespace for this endpoint/account. Changing it
   * deliberately invalidates old handles, rather than routing them elsewhere. */
  deploymentId: string;
  network: OpenSandboxNetworkPort;
  /** Explicit provider custody opt-in. Default keeps secrets in OpenMA gateway. */
  credentialInjection?: "gateway" | "provider";
  gateway: { hosts: string[]; fixedIps?: readonly string[] };
  channels?: string[];
  /** Fast templates fix the image. Explicit binding prevents silently ignoring
   * a catalog image. Generated v2 templates are snapshot refs, not fsb IDs. */
  fastBase?: { image: string; templateId: string };
}

const backendNames = ["docker", "kubernetes", "fast"];
const labelKeys = { workspaceId: "oma-workspace", sessionId: "oma-session", deploymentId: "oma-deployment", backend: "oma-backend" };
const terminal = new Set(["terminated", "deleted", "failed", "error"]);
function label(value: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/.test(value)) {
    throw new SandboxAssemblyError("OpenSandbox v2 ownership labels must be lossless Kubernetes label values (1–63 characters)");
  }
  return value;
}
function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
}
function mapped(error: unknown, operation: string): Error {
  // Do not retain SDK causes: upstream bodies/URLs may contain credentials.
  const code = status(error);
  const message = `OpenSandbox v2 ${operation} failed${code === undefined ? "" : ` (HTTP ${code})`}`;
  if (code === 429 || code === 503) return new RetryableSandboxError(message, 1_000);
  if (code === 404) return new SandboxGoneError(message);
  return new Error(message);
}
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** Native lifecycle, not the v1 provider bridge. Generic v2 CAS Memory/output
 * sync and gateway substitution are composed by createSandboxPorts. No shared
 * deployment volumes are allowed: one static PVC/host path would cross sessions.
 * Pause means Ready snapshot → pause compute. This retains the saved handle
 * across the host's ref-publication window, with a separate snapshot for
 * recovery after paused TTL expiry. Restored handles may change. */
export function createOpenSandboxV2Adapter(config: OpenSandboxV2Options): SandboxAdapterPort<OpenSandbox> {
  const { sdk, options, network } = config;
  const backend = options.runtime;
  if (!backend || !backendNames.includes(backend)) throw new SandboxAssemblyError("OpenSandbox v2 requires explicit OPENSANDBOX_RUNTIME backend");
  label(config.deploymentId);
  if (config.credentialInjection !== undefined && !["gateway", "provider"].includes(config.credentialInjection)) throw new SandboxAssemblyError("Unknown credential injection mode");
  if (config.credentialInjection === "provider" && backend === "fast") throw new SandboxAssemblyError("Fast Sandbox does not support provider Credential Vault; choose gateway");
  if (!network || typeof network.prepare !== "function" || typeof network.replace !== "function") throw new SandboxAssemblyError("OpenSandbox v2 requires a deployment network enforcement port (including IP/CIDR hard denies)");
  if (options.volumes.length) throw new SandboxAssemblyError("OpenSandbox v2 does not accept deployment-shared volumes; use session-scoped v2 storage sync");
  const connectionConfig = { domain: options.domain, protocol: options.protocol, apiKey: options.apiKey, requestTimeoutSeconds: 60, disableMetrics: true };
  const clients = new WeakMap<OpenSandbox, SDK.Sandbox>();
  const metadata = (s: Pick<Scope, "workspaceId" | "sessionId">, kind?: string) => ({ backend, deploymentId: config.deploymentId, credentialInjection: config.credentialInjection ?? "gateway", workspaceId: s.workspaceId, ...(kind === "template" ? {} : { sessionId: s.sessionId }), ...(kind ? { kind } : {}) });
  const own = (ref: SandboxHandle | ResumeRef | TemplateRef, scope?: Scope) => {
    const m = ref.metadata;
    if (ref.provider !== "opensandbox" || m?.backend !== backend || m?.deploymentId !== config.deploymentId || m?.credentialInjection !== (config.credentialInjection ?? "gateway") ||
      (scope && (m.workspaceId !== scope.workspaceId || (m.kind !== "template" && m.sessionId !== scope.sessionId)))) {
      throw new SandboxAssemblyError("Incompatible OpenSandbox v2 reference (deployment, backend or owner mismatch)");
    }
  };
  const managerCall = async <T>(operation: (manager: SDK.SandboxManager) => Promise<T>): Promise<T> => {
    const manager = sdk.SandboxManager.create({ connectionConfig });
    try { return await operation(manager); } finally { await manager.close(); }
  };
  const clientOf = (runtime: OpenSandbox) => {
    const c = clients.get(runtime);
    if (!c) throw new SandboxAssemblyError("Runtime does not belong to this OpenSandbox v2 adapter");
    return c;
  };
  const wrap = async (client: SDK.Sandbox, scope: Scope): Promise<Acquired<OpenSandbox>> => {
    const probe = await client.commands.run("pwd", {});
    if (!probe.complete || probe.exitCode) throw new Error("Cannot resolve OpenSandbox workspace");
    const root = workspaceRootFromProbe(joinOutputLines(probe.logs.stdout));
    await client.files.createDirectories([{ path: root, mode: 755 }, { path: PLATFORM_ROOT, mode: 755 }]);
    const runtime = new OpenSandbox(client, options, root);
    clients.set(runtime, client);
    return { runtime, handle: { provider: "opensandbox", runtimeId: client.id, metadata: metadata(scope) } };
  };
  const validatePlan = (scope: Scope, plan: SandboxPlan) => {
    if (plan.labels.workspaceId !== scope.workspaceId || plan.labels.sessionId !== scope.sessionId) throw new SandboxAssemblyError("Plan labels do not match Session scope");
    label(plan.labels.workspaceId); label(plan.labels.sessionId);
    if (!Number.isFinite(plan.idleMs) || plan.idleMs < 0 || plan.idleMs >= options.timeoutSeconds * 1000) throw new SandboxAssemblyError("OpenSandbox lease must exceed plan idleMs");
    if (plan.egress && (plan.egress.scope.workspaceId !== scope.workspaceId || plan.egress.scope.sessionId !== scope.sessionId)) throw new SandboxAssemblyError("Network policy owner mismatch");
  };
  const start = async (scope: Scope, plan: SandboxPlan, signal: AbortSignal, snapshot?: string): Promise<Acquired<OpenSandbox> | "gone"> => {
    signal.throwIfAborted(); validatePlan(scope, plan);
    const rules = compileFirewall(plan.egress, { gateway: config.gateway, channels: config.channels ?? [] });
    const networkPolicy = await network.prepare(rules);
    if (!snapshot && backend === "fast" && (!("image" in plan.from) || config.fastBase?.image !== plan.from.image || !config.fastBase.templateId)) {
      throw new SandboxAssemblyError("Fast backend requires an explicit image-to-template binding");
    }
    const common = { connectionConfig, timeoutSeconds: options.timeoutSeconds, readyTimeoutSeconds: options.readyTimeoutMs / 1000, signal,
      networkPolicy, metadata: { [labelKeys.workspaceId]: scope.workspaceId, [labelKeys.sessionId]: scope.sessionId, [labelKeys.deploymentId]: config.deploymentId, [labelKeys.backend]: backend } };
    let client: SDK.Sandbox;
    try {
      client = backend === "fast" && !snapshot
        ? await sdk.Sandbox.createFromTemplate({ ...common, templateId: config.fastBase!.templateId })
        : await sdk.Sandbox.create({ ...common, ...(snapshot ? { snapshotId: snapshot } : { image: (plan.from as { image: string }).image }), resource: backend === "fast" ? {} : { cpu: options.cpu, memory: options.memory }, ...(config.credentialInjection === "provider" ? { credentialProxy: { enabled: true } } : {}), entrypoint: ["tail", "-f", "/dev/null"] });
    } catch (error) { if (status(error) === 404) return "gone"; throw mapped(error, "allocate"); }
    try {
      signal.throwIfAborted();
      await network.replace(client, rules);
      return await wrap(client, scope);
    } catch (error) {
      try { await client.kill(); } finally { await client.close(); }
      throw error;
    }
  };
  const snapshot = async (input: { runtime: OpenSandbox; handle: SandboxHandle; signal: AbortSignal }, kind: "snapshot" | "template"): Promise<ResumeRef> => {
    own(input.handle); input.signal.throwIfAborted();
    if (clientOf(input.runtime).id !== input.handle.runtimeId) throw new SandboxAssemblyError("Runtime and handle mismatch");
    // Defensive barrier: checkpoint callers must not serialize provider secrets,
    // even if they forgot the egress.revoke step. No snapshot on failed revoke.
    if (config.credentialInjection === "provider") await revokeOpenSandboxVault(clientOf(input.runtime).credentialVault);
    try {
      return await managerCall(async manager => {
        let snap = await manager.createSnapshot(input.handle.runtimeId);
        const deadline = Date.now() + options.snapshotTimeoutMs;
        while (snap.status.state !== "Ready") {
          input.signal.throwIfAborted();
          if (snap.status.state === "Failed" || Date.now() >= deadline) throw new Error("Snapshot not ready");
          await new Promise(resolve => setTimeout(resolve, options.snapshotPollMs));
          snap = await manager.getSnapshot(snap.id);
        }
        return { provider: "opensandbox", ref: snap.id, metadata: { ...input.handle.metadata, kind, ...(kind === "template" ? { sessionId: null } : {}) } };
      });
    } catch (error) { throw mapped(error, "snapshot"); }
  };
  const lifecycle: SandboxLifecyclePort<OpenSandbox> = {
    handle: "changes", maxLifetimeMs: null, // renewable absolute expiry, not a continuous-runtime cap
    async acquire(input) {
      if ("template" in input.plan.from) {
        own(input.plan.from.template, input.scope);
        if (input.plan.from.template.metadata?.kind !== "template") throw new SandboxAssemblyError("Expected template reference");
        return start(input.scope, input.plan, input.signal, input.plan.from.template.ref);
      }
      return start(input.scope, input.plan, input.signal);
    },
    async attach(input) {
      own(input.handle, input.scope); input.signal.throwIfAborted();
      let client: SDK.Sandbox | undefined;
      try {
        const info = await managerCall(m => m.getSandboxInfo(input.handle.runtimeId));
        if (terminal.has(info.status.state.toLowerCase())) return "gone";
        const expected = { [labelKeys.workspaceId]: input.scope.workspaceId, [labelKeys.sessionId]: input.scope.sessionId, [labelKeys.deploymentId]: config.deploymentId, [labelKeys.backend]: backend };
        if (Object.entries(expected).some(([k, v]) => info.metadata?.[k] !== v)) throw new SandboxAssemblyError("Provider ownership differs from handle reference");
        const state = info.status.state.toLowerCase();
        if (state !== "running" && state !== "paused") throw new SandboxAssemblyError("OpenSandbox v2 attach requires running or paused state");
        const connect = { sandboxId: input.handle.runtimeId, connectionConfig, signal: input.signal, readyTimeoutSeconds: options.readyTimeoutMs / 1000 };
        if (state === "paused" && backend === "fast") await managerCall(m => m.renewSandbox(input.handle.runtimeId, options.timeoutSeconds));
        client = state === "paused" ? await sdk.Sandbox.resume(connect) : await sdk.Sandbox.connect(connect);
        await client.renew(options.timeoutSeconds);
        return await wrap(client, input.scope);
      } catch (error) {
        await client?.close();
        if (status(error) === 404) return "gone";
        if (error instanceof SandboxAssemblyError) throw error;
        throw mapped(error, "attach");
      }
    },
    async keepAlive(input) {
      own(input.handle);
      const client = clientOf(input.runtime);
      if (client.id !== input.handle.runtimeId) throw new SandboxAssemblyError("Runtime and handle mismatch");
      try {
        const info = await managerCall(m => m.getSandboxInfo(client.id));
        if (terminal.has(info.status.state.toLowerCase())) return "gone";
        if (info.status.state.toLowerCase() !== "running") throw new SandboxAssemblyError("OpenSandbox is not running");
        await client.renew(options.timeoutSeconds); return "alive";
      }
      catch (error) { if (status(error) === 404) return "gone"; throw mapped(error, "renew"); }
    },
    async checkpoint(input) { own(input.handle, input.scope); return snapshot(input, "snapshot"); },
    async pause(input) {
      own(input.handle, input.scope);
      const ref = await snapshot(input, "snapshot");
      // Keep the saved handle across the host's ref-publication window. The
      // separate snapshot survives expiry of this paused resource's TTL.
      await input.runtime.suspend({ kind: options.suspendKind });
      await clientOf(input.runtime).close();
      return ref;
    },
    async resume(input) {
      own(input.ref, input.scope);
      if (input.ref.metadata?.kind !== "snapshot") throw new SandboxAssemblyError("Expected snapshot reference");
      return start(input.scope, input.plan, input.signal, input.ref.ref);
    },
    async release(input) {
      own(input.handle, input.scope);
      try { await managerCall(m => m.killSandbox(input.handle.runtimeId)); }
      catch (error) { if (status(error) !== 404) throw mapped(error, "release"); }
    },
    async discard(input) {
      own(input.ref, input.scope);
      if (!["snapshot", "template"].includes(String(input.ref.metadata?.kind))) throw new SandboxAssemblyError("Expected snapshot reference");
      try { await managerCall(m => m.deleteSnapshot(input.ref.ref)); }
      catch (error) { if (status(error) !== 404) throw mapped(error, "discard"); }
    },
    snapshotTemplate: input => snapshot(input, "template"),
    async list(input) {
      input.signal.throwIfAborted();
      const filter = { [labelKeys.deploymentId]: config.deploymentId, [labelKeys.backend]: backend, ...Object.fromEntries(Object.entries(input.labels).filter(([, v]) => v !== undefined).map(([k, v]) => [labelKeys[k as "workspaceId" | "sessionId"], label(v!)])) };
      try {
        return await managerCall(async manager => {
          const result: Awaited<ReturnType<typeof lifecycle.list>> = [];
          for (let page = 1; ; page++) {
            input.signal.throwIfAborted();
            const response = await manager.listSandboxInfos({ metadata: filter, page, pageSize: 100 });
            for (const item of response.items) {
              if (Object.entries(filter).some(([k, v]) => item.metadata?.[k] !== v)) continue;
              const workspaceId = item.metadata?.[labelKeys.workspaceId], sessionId = item.metadata?.[labelKeys.sessionId];
              if (!workspaceId || !sessionId || terminal.has(item.status.state.toLowerCase())) continue;
              result.push({ handle: { provider: "opensandbox", runtimeId: item.id, metadata: metadata({ workspaceId, sessionId }) }, labels: { workspaceId, sessionId }, createdAt: item.createdAt.toISOString() });
            }
            if (!response.pagination?.hasNextPage) return result;
          }
        });
      } catch (error) { throw mapped(error, "list"); }
    },
  };
  const vendor: SandboxVendorPort<OpenSandbox> = {
    async exec(runtime, command, opts) {
      let stdinPath: string | undefined;
      try {
        if (opts?.stdin !== undefined) {
          stdinPath = `/tmp/oma-v2-stdin-${crypto.randomUUID()}`;
          await runtime.writePrivateFiles(stdinPath, { input: new TextEncoder().encode(opts.stdin) });
          command = `(${command}) < ${quote(`${stdinPath}/input`)}`;
        }
        const result = await runtime.run(command, opts?.timeoutMs);
        if (result.error && !result.exitCode) throw new Error("Command failed without exit code");
        return { exitCode: result.exitCode ?? 0, stdout: joinOutputLines(result.logs.stdout), stderr: joinOutputLines(result.logs.stderr) };
      } finally { if (stdinPath) await runtime.removeDirectory(stdinPath); }
    },
    async readFile(runtime, path) {
      try { return await clientOf(runtime).files.readBytes(runtime.resolvePath(path)); }
      catch (error) {
        if (status(error) === 404) {
          // A file 404 is not necessarily sandbox loss.
          try { await managerCall(m => m.getSandboxInfo(runtime.id)); } catch (probe) { throw mapped(probe, "read"); }
          return null;
        }
        throw mapped(error, "read");
      }
    },
    async writeFile(runtime, path, bytes) { await runtime.writeFileBytes(path, bytes); },
    setEnv: (runtime, env) => runtime.setEnvVars(env),
    applyFirewall: (runtime, rules) => network.replace(clientOf(runtime), rules),
    asSandboxPort: runtime => runtime,
  };
  return {
    name: "opensandbox", lifecycle, vendor,
    ...(config.credentialInjection === "provider" ? { native: {
      egress: (deps: import("@open-managed-agents/sandbox-port-kit/ports").SandboxEgressDepsPort) => ({
        port: createOpenSandboxNativeEgress(vendor, runtime => clientOf(runtime).credentialVault, deps),
      }),
    } } : {}),
  };
}
