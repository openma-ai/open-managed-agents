// fromV1SandboxFactory (design §0.2): a bare v1 SandboxFactory as a v2 adapter.
// A capability v1 lacks degrades as the §0.1 method comments allow or fails
// the call with a typed error.

import { parseExecResult, supportsPreparedBase, supportsSandboxRuntime } from "@open-managed-agents/sandbox";
import type {
  ResumeRef,
  SandboxHandle,
  SandboxLifecyclePort,
  SandboxPlan,
  SandboxPort,
  TemplateRef,
} from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { SandboxAssemblyError, SandboxTemplateUnsupportedError, type SandboxAdapterPort, type SandboxVendorPort } from "./ports";

export interface V1SandboxFactoryBridgeOptions<R extends SandboxPort> {
  /** Provider name written into handles and refs. */
  name: string;
  /** Creates a sandbox for the Session: the host's v1 factory call (images,
   * prepared bases and allocation stay the host's). */
  create(input: { scope: RuntimeResourceScope; plan: SandboxPlan; signal: AbortSignal }): Promise<R>;
  /** Lease renewed by keepAlive on runtimes that have one. */
  leaseTtlMs?: number;
  /** The runtimes this process holds, by handle; shared by every bridge of a
   * deployment so a handle recorded by one (e.g. a warm-up) attaches in another. */
  held?: Map<string, R>;
}

/** A bare v1 SandboxFactory (no SandboxProviderPort: it cannot find a
 * sandbox again, and has no snapshot to start a new one from; use
 * fromV1SandboxProvider, ./v1-provider-bridge, when the provider has one) as a v2 adapter. Handles ("changes") name runtimes this
 * bridge holds: attach finds one while this process holds it, else
 * "gone" and the core acquires again. Degrades as the §0.1 comments allow:
 * pause and checkpoint return a ref to the sandbox itself (the provider's
 * own lease reclaims it); nothing to list, the handles live in memory. */
export function fromV1SandboxFactory<R extends SandboxPort>(options: V1SandboxFactoryBridgeOptions<R>): SandboxAdapterPort<R> {
  const held = options.held ?? new Map<string, R>();
  const selfRef = (handle: SandboxHandle): ResumeRef => ({ provider: options.name, ref: handle.runtimeId, kind: "self" });
  const find = async (runtimeId: string): Promise<R | null> => {
    const runtime = held.get(runtimeId);
    if (runtime === undefined) return null;
    if (supportsSandboxRuntime(runtime) && await runtime.status() === "stopped") return null;
    return runtime;
  };
  const lifecycle: SandboxLifecyclePort<R> = {
    handle: "changes",
    maxLifetimeMs: null,
    async acquire(input) {
      input.signal.throwIfAborted();
      const runtime = await options.create(input);
      const handle = { provider: options.name, runtimeId: crypto.randomUUID() };
      held.set(handle.runtimeId, runtime);
      return { runtime, handle };
    },
    async attach(input) {
      const runtime = await find(input.handle.runtimeId);
      return runtime === null ? "gone" : { runtime, handle: input.handle };
    },
    async keepAlive(input) {
      if (!supportsSandboxRuntime(input.runtime)) return "alive";
      if (await input.runtime.status() === "stopped") return "gone";
      const ttlMs = input.ttlMs ?? options.leaseTtlMs;
      if (ttlMs !== undefined && input.runtime.runtimeCapabilities().lease) await input.runtime.renewLease({ ttlMs });
      return "alive";
    },
    async checkpoint(input) { return selfRef(input.handle); },
    async pause(input) { return selfRef(input.handle); },
    async resume(input) {
      const runtime = await find(input.ref.ref);
      return runtime === null ? "gone" : { runtime, handle: { provider: options.name, runtimeId: input.ref.ref } };
    },
    async release(input) {
      const runtime = held.get(input.handle.runtimeId);
      held.delete(input.handle.runtimeId);
      await runtime?.destroy?.();
    },
    async discard() {},
    async snapshotTemplate(input): Promise<TemplateRef> {
      if (!supportsPreparedBase(input.runtime)) throw new SandboxTemplateUnsupportedError(`${options.name}: provider cannot capture a prepared base`);
      const base = await input.runtime.capturePreparedBase({ name: `oma-template-${input.handle.runtimeId}` });
      return { provider: base.provider, ref: base.id };
    },
    async list() { return []; },
  };
  return { name: options.name, lifecycle, vendor: v1Vendor<R>(options.name) };
}

/** Vendor primitives over a v1 SandboxPort. A runtime without bytes I/O or
 * setEnvVars fails the call with a typed error. */
export function v1Vendor<R extends SandboxPort>(name: string): SandboxVendorPort<R> {
  return {
    async exec(runtime, cmd, opts) {
      let command = cmd;
      let stdinPath: string | null = null;
      if (opts?.stdin !== undefined) {
        stdinPath = `/tmp/.oma-stdin-${crypto.randomUUID()}`;
        await runtime.writeFile(stdinPath, opts.stdin);
        command = `(${cmd}) < ${stdinPath}; s=$?; rm -f ${stdinPath}; exit $s`;
      }
      return parseExecResult(await runtime.exec(command, opts?.timeoutMs));
    },
    async readFile(runtime, path) {
      if (runtime.readFileBytes === undefined) throw new SandboxAssemblyError(`${name}: runtime cannot read bytes`);
      const probe = parseExecResult(await runtime.exec(`test -e ${shellQuote(path)}`, 10_000));
      if (probe.exitCode !== 0) return null;
      return runtime.readFileBytes(path);
    },
    async writeFile(runtime, path, bytes) {
      if (runtime.writeFileBytes === undefined) throw new SandboxAssemblyError(`${name}: runtime cannot write bytes`);
      await runtime.writeFileBytes(path, bytes);
    },
    async setEnv(runtime, env) {
      if (runtime.setEnvVars === undefined) throw new SandboxAssemblyError(`${name}: runtime cannot set environment variables`);
      await runtime.setEnvVars(env);
    },
    asSandboxPort: (runtime) => runtime,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
