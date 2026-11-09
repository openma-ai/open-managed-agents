// fromV1SandboxFactory (design §0.2): a bare v1 SandboxFactory as a v2 adapter.
// A capability v1 lacks degrades as the §0.1 method comments allow or fails
// the call with a typed error.

import { parseExecResult, supportsSandboxRuntime } from "@open-managed-agents/sandbox";
import type {
  ResumeRef,
  SandboxHandle,
  SandboxLifecyclePort,
  SandboxPlan,
  SandboxPort,
  TemplateRef,
  SandboxProviderPort,
  SandboxRuntimePort,
} from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { SandboxAssemblyError, type SandboxAdapterPort, type SandboxVendorPort } from "./ports";

type V1Runtime = SandboxPort & SandboxRuntimePort;

export interface V1SandboxProviderBridgeOptions<R extends V1Runtime> {
  /** Provider name written into handles and refs. */
  name: string;
  /** A v1 provider object. A bare SandboxFactory cannot attach or resume and
   * is rejected. */
  provider: SandboxProviderPort<R>;
  /** v1 creation context for a Session. `plan` is null on attach, resume of
   * a runtime ref, and release. */
  context(scope: RuntimeResourceScope, plan: SandboxPlan | null): SandboxFactoryContext;
  env: SandboxFactoryEnv;
  /** Lease renewed by keepAlive on providers that have one. Must exceed the
   * plan's idleMs or the provider reclaims the sandbox first. */
  leaseTtlMs: number;
  /** v1 create takes no labels and v1 has no listing, so a deployment that
   * wants orphan reaping supplies the listing itself. */
  list?: SandboxLifecyclePort<R>["list"];
  /** Readiness polling after create / resume. */
  readiness?: { timeoutMs: number; pollMs: number };
}

const CHECKPOINT_KEY = "v1Checkpoint";

export function fromV1SandboxProvider<R extends V1Runtime>(
  options: V1SandboxProviderBridgeOptions<R>,
): SandboxAdapterPort<R> {
  const provider = options.provider as unknown;
  if (typeof provider === "function") {
    throw new SandboxAssemblyError(`${options.name}: a SandboxFactory cannot attach or resume; pass a SandboxProviderPort`);
  }
  const candidate = provider as Partial<SandboxProviderPort<R>> | null;
  if (candidate === null || typeof candidate !== "object"
    || typeof candidate.create !== "function" || typeof candidate.resume !== "function" || typeof candidate.restore !== "function") {
    throw new SandboxAssemblyError(`${options.name}: provider must implement create, resume and restore`);
  }
  if (options.list === undefined) {
    throw new SandboxAssemblyError(`${options.name}: v1 providers cannot list sandboxes by label; supply list for orphan reaping`);
  }
  if (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
    throw new SandboxAssemblyError(`${options.name}: leaseTtlMs must be a positive integer`);
  }
  const list = options.list;
  const readiness = options.readiness ?? { timeoutMs: 120_000, pollMs: 1_000 };

  const handleOf = (runtime: R): SandboxHandle => {
    const handle = runtime.runtimeHandle();
    if (handle.provider !== options.name) {
      throw new Error(`${options.name}: runtime belongs to provider ${handle.provider}`);
    }
    return { provider: handle.provider, runtimeId: handle.runtimeId };
  };
  const requireOwn = (value: { provider: string }, what: string) => {
    if (value.provider !== options.name) throw new Error(`${options.name}: ${what} belongs to provider ${value.provider}`);
  };

  async function ready(runtime: R, signal: AbortSignal): Promise<boolean> {
    const started = Date.now();
    for (;;) {
      signal.throwIfAborted();
      const state = await runtime.status();
      if (state === "running") return true;
      if (state === "stopped") return false;
      if (Date.now() - started >= readiness.timeoutMs) {
        throw new Error(`${options.name}: runtime readiness timed out after ${readiness.timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, readiness.pollMs));
    }
  }

  /** v1 resume / restore throw on any failure, including "not found": the
   * bridge cannot tell them apart, so every failure is reported as gone. */
  async function settle(open: () => Promise<R>, signal: AbortSignal): Promise<Acquired<R> | "gone"> {
    let runtime: R;
    try {
      runtime = await open();
    } catch {
      return "gone";
    }
    if (!await ready(runtime, signal)) return "gone";
    return { runtime, handle: handleOf(runtime) };
  }

  const selfRef = (handle: SandboxHandle): ResumeRef => ({ provider: options.name, ref: handle.runtimeId, metadata: { kind: "self" } });
  const checkpointRef = (checkpoint: SandboxCheckpointHandle): ResumeRef => ({
    provider: options.name,
    ref: checkpoint.checkpointId,
    metadata: { [CHECKPOINT_KEY]: JSON.stringify(checkpoint) },
  });
  const checkpointOf = (ref: ResumeRef): SandboxCheckpointHandle | null => {
    const raw = ref.metadata?.[CHECKPOINT_KEY];
    return typeof raw === "string" ? JSON.parse(raw) as SandboxCheckpointHandle : null;
  };
  const suspendKind = (runtime: R) => {
    const kinds = runtime.runtimeCapabilities().suspend;
    return kinds.includes("filesystem") ? "filesystem" : kinds[0];
  };

  const lifecycle: SandboxLifecyclePort<R> = {
    handle: "changes",
    /** v1 declares no continuous-run cap. */
    maxLifetimeMs: null,

    /** v1 cannot snapshot an environment, so plans only carry images; a
     * failed create throws, it never returns "gone". */
    async acquire(input) {
      input.signal.throwIfAborted();
      const context = options.context(input.scope, input.plan);
      const runtime = await options.provider.create(context, options.env);
      try {
        if (!await ready(runtime, input.signal)) throw new Error(`${options.name}: runtime stopped before it became ready`);
        return { runtime, handle: handleOf(runtime) };
      } catch (error) {
        await runtime.destroy?.().catch(() => undefined);
        throw error;
      }
    },

    async attach(input) {
      requireOwn(input.handle, "handle");
      return settle(() => options.provider.resume(
        { provider: options.name, runtimeId: input.handle.runtimeId },
        options.context(input.scope, null),
        options.env,
      ), input.signal);
    },

    async keepAlive(input) {
      if (await input.runtime.status() === "stopped") return "gone";
      if (input.runtime.runtimeCapabilities().lease) await input.runtime.renewLease({ ttlMs: options.leaseTtlMs });
      return "alive";
    },

    /** Providers without a live checkpoint return a ref to the sandbox itself. */
    async checkpoint(input) {
      input.signal.throwIfAborted();
      const kinds = input.runtime.runtimeCapabilities().checkpoint;
      if (kinds.length === 0) return selfRef(input.handle);
      return checkpointRef(await input.runtime.checkpoint({ kind: kinds.includes("filesystem") ? "filesystem" : kinds[0]! }));
    },

    /** Providers without suspend are auto-pause-only: a ref to themselves. */
    async pause(input) {
      input.signal.throwIfAborted();
      const kind = suspendKind(input.runtime);
      if (kind === undefined) return selfRef(input.handle);
      return checkpointRef(await input.runtime.suspend({ kind }));
    },

    async resume(input) {
      requireOwn(input.ref, "ref");
      const checkpoint = checkpointOf(input.ref);
      const context = options.context(input.scope, input.plan);
      if (checkpoint === null) {
        return settle(() => options.provider.resume({ provider: options.name, runtimeId: input.ref.ref }, context, options.env), input.signal);
      }
      if (checkpoint.scope === "portable") {
        return settle(() => options.provider.restore(checkpoint, context, options.env), input.signal);
      }
      return settle(async () => {
        const runtime = await options.provider.resume({ provider: options.name, runtimeId: checkpoint.sourceRuntimeId }, context, options.env);
        if (await runtime.status() === "suspended") await runtime.resume(checkpoint);
        return runtime;
      }, input.signal);
    },

    /** v1 has no delete-by-id: release reopens the runtime and destroys it.
     * A runtime that cannot be reopened is treated as already deleted. */
    async release(input) {
      requireOwn(input.handle, "handle");
      let runtime: R;
      try {
        runtime = await options.provider.resume(
          { provider: options.name, runtimeId: input.handle.runtimeId },
          options.context(input.scope, null),
          options.env,
        );
      } catch {
        return;
      }
      await runtime.destroy?.();
    },

    /** v1 has no API to delete a checkpoint: no-op, refs wait for provider expiry. */
    async discard() {},

    list: (input) => list(input),
  };

  return { name: options.name, lifecycle, vendor: v1Vendor<R>(options.name) };
}

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
 * sandbox again) as a v2 adapter. Handles ("changes") name runtimes this
 * bridge holds: attach finds one while this process holds it, else
 * "gone" and the core acquires again. Degrades as the §0.1 comments allow:
 * pause and checkpoint return a ref to the sandbox itself (the provider's
 * own lease reclaims it); nothing to list, the handles live in memory. */
export function fromV1SandboxFactory<R extends SandboxPort>(options: V1SandboxFactoryBridgeOptions<R>): SandboxAdapterPort<R> {
  const held = options.held ?? new Map<string, R>();
  const selfRef = (handle: SandboxHandle): ResumeRef => ({ provider: options.name, ref: handle.runtimeId, metadata: { kind: "self" } });
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
      if (options.leaseTtlMs !== undefined && input.runtime.runtimeCapabilities().lease) await input.runtime.renewLease({ ttlMs: options.leaseTtlMs });
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
    async list() { return []; },
  };
  return { name: options.name, lifecycle, vendor: v1Vendor<R>(options.name) };
}

const runtimeIdentities = new WeakMap<object, string>();

/** Vendor primitives over a v1 SandboxPort. A runtime without bytes I/O or
 * setEnvVars fails the call with a typed error. */
export function v1Vendor<R extends SandboxPort>(name: string): SandboxVendorPort<R> {
  return {
    sandboxIdentity: (runtime) => {
      if (supportsSandboxRuntime(runtime)) return name + ":" + runtime.runtimeHandle().runtimeId;
      let id = runtimeIdentities.get(runtime);
      if (id === undefined) { id = crypto.randomUUID(); runtimeIdentities.set(runtime, id); }
      return id;
    },
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
