// fromV1SandboxProvider (design §0.2, §0.0b A.8): a v1 SandboxProviderPort as
// a v2 adapter. Unlike fromV1SandboxFactory it finds a sandbox again by its
// handle through the provider's own API (provider.resume), so the handle the
// core records survives a process restart; nothing is looked up in process
// memory. Restored from ea4f398d (removed in d7be52bb while it had no caller).
//
// handle     "changes" (the provider's runtimeHandle)
// acquire    options.create (the host's builder: images, prepared bases,
//            workdir), else provider.create
// attach     provider.resume(handle); any failure or a stopped runtime → "gone"
// checkpoint runtime.checkpoint, filesystem preferred: a portable checkpoint is
//            kind "snapshot"; a runtime-scoped one is kind "self"
// pause      runtime.suspend → kind "self" (in place); without suspend the
//            sandbox keeps running and pause returns kind "self" too
// resume     "self" → provider.resume (+ runtime.resume of a suspended one);
//            "snapshot" → provider.restore into a new runtime
// discard    provider.discard of a snapshot when the provider has one
// release    provider.resume then destroy (v1 has no delete by id)

import { supportsPreparedBase } from "@open-managed-agents/sandbox";
import type {
  Acquired,
  ResumeRef,
  SandboxCheckpointHandle,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxHandle,
  SandboxLifecyclePort,
  SandboxPlan,
  SandboxPort,
  SandboxProviderPort,
  SandboxRuntimePort,
  TemplateRef,
} from "@open-managed-agents/sandbox";
import type { RuntimeResourceScope } from "@open-managed-agents/runtime-resource-contract";
import { SandboxAssemblyError, SandboxTemplateUnsupportedError, type SandboxAdapterPort } from "./ports";
import { v1Vendor } from "./v1-bridge";

type V1Runtime = SandboxPort & SandboxRuntimePort;

export interface V1SandboxProviderBridgeOptions<R extends V1Runtime> {
  /** Provider name written into handles and refs; must match runtimeHandle().provider. */
  name: string;
  /** A v1 provider object (create / resume / restore). A bare SandboxFactory
   * cannot find a sandbox again and is rejected. */
  provider: SandboxProviderPort<R>;
  /** v1 context for a Session. `plan` is null on attach and release. */
  context(scope: RuntimeResourceScope, plan: SandboxPlan | null): SandboxFactoryContext;
  env: SandboxFactoryEnv;
  /** Creates a new sandbox; omitted = provider.create(context(scope, plan)). */
  create?(input: { scope: RuntimeResourceScope; plan: SandboxPlan; signal: AbortSignal }): Promise<R>;
  /** Lease renewed by keepAlive on providers that have one. */
  leaseTtlMs: number;
  /** v1 has no listing by label: orphan reaping lists through this. */
  list: SandboxLifecyclePort<R>["list"];
  /** Readiness polling after create / resume. */
  readiness?: { timeoutMs: number; pollMs: number };
}

const CHECKPOINT_KEY = "v1Checkpoint";

export function fromV1SandboxProvider<R extends V1Runtime>(options: V1SandboxProviderBridgeOptions<R>): SandboxAdapterPort<R> {
  const provider = options.provider as unknown;
  if (typeof provider === "function") {
    throw new SandboxAssemblyError(`${options.name}: a SandboxFactory cannot find a sandbox again; pass a SandboxProviderPort`);
  }
  const candidate = provider as Partial<SandboxProviderPort<R>> | null;
  if (candidate === null || typeof candidate !== "object"
    || typeof candidate.create !== "function" || typeof candidate.resume !== "function" || typeof candidate.restore !== "function") {
    throw new SandboxAssemblyError(`${options.name}: provider must implement create, resume and restore`);
  }
  if (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
    throw new SandboxAssemblyError(`${options.name}: leaseTtlMs must be a positive integer`);
  }
  const readiness = options.readiness ?? { timeoutMs: 120_000, pollMs: 1_000 };

  const handleOf = (runtime: R): SandboxHandle => {
    const handle = runtime.runtimeHandle();
    if (handle.provider !== options.name) throw new Error(`${options.name}: runtime belongs to provider ${handle.provider}`);
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
      if (Date.now() - started >= readiness.timeoutMs) throw new Error(`${options.name}: runtime readiness timed out after ${readiness.timeoutMs}ms`);
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

  const selfRef = (handle: SandboxHandle): ResumeRef => ({ provider: options.name, ref: handle.runtimeId, kind: "self" });
  const checkpointRef = (checkpoint: SandboxCheckpointHandle): ResumeRef => ({
    provider: options.name,
    ref: checkpoint.checkpointId,
    kind: checkpoint.scope === "portable" ? "snapshot" : "self",
    metadata: { [CHECKPOINT_KEY]: JSON.stringify(checkpoint) },
  });
  const checkpointOf = (ref: ResumeRef): SandboxCheckpointHandle | null => {
    const raw = ref.metadata?.[CHECKPOINT_KEY];
    return typeof raw === "string" ? JSON.parse(raw) as SandboxCheckpointHandle : null;
  };
  const preferred = (kinds: readonly ("filesystem" | "memory")[]) => kinds.includes("filesystem") ? "filesystem" as const : kinds[0];

  const lifecycle: SandboxLifecyclePort<R> = {
    handle: "changes",
    /** v1 declares no continuous-run cap. */
    maxLifetimeMs: null,

    async acquire(input) {
      input.signal.throwIfAborted();
      let runtime: R;
      if (options.create !== undefined) {
        runtime = await options.create(input);
      } else {
        const context = options.context(input.scope, input.plan);
        if ("template" in input.plan.from) {
          requireOwn(input.plan.from.template, "template");
          context.preparedBase = { provider: options.name, id: input.plan.from.template.ref };
        }
        runtime = await options.provider.create(context, options.env);
      }
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
      if (input.runtime.runtimeCapabilities().lease) await input.runtime.renewLease({ ttlMs: input.ttlMs ?? options.leaseTtlMs });
      return "alive";
    },

    async checkpoint(input) {
      input.signal.throwIfAborted();
      const kind = preferred(input.runtime.runtimeCapabilities().checkpoint);
      if (kind === undefined) return selfRef(input.handle);
      return checkpointRef(await input.runtime.checkpoint({ kind }));
    },

    async pause(input) {
      input.signal.throwIfAborted();
      const kind = preferred(input.runtime.runtimeCapabilities().suspend);
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

    /** v1 has no delete by id: release reopens the runtime and destroys it.
     * A runtime that cannot be reopened is treated as already deleted. */
    async release(input) {
      requireOwn(input.handle, "handle");
      let runtime: R;
      try {
        runtime = await options.provider.resume({ provider: options.name, runtimeId: input.handle.runtimeId }, options.context(input.scope, null), options.env);
      } catch {
        return;
      }
      await runtime.destroy?.();
    },

    /** A snapshot through provider.discard; a ref to the sandbox itself, or
     * a provider without discard, is a no-op (the snapshot waits for expiry). */
    async discard(input) {
      if (!("kind" in input.ref) || input.ref.kind !== "snapshot") return;
      const checkpoint = checkpointOf(input.ref);
      if (checkpoint !== null) await options.provider.discard?.(checkpoint, options.env);
    },

    async snapshotTemplate(input): Promise<TemplateRef> {
      input.signal.throwIfAborted();
      if (!supportsPreparedBase(input.runtime)) throw new SandboxTemplateUnsupportedError(`${options.name}: provider cannot capture a prepared base`);
      const base = await input.runtime.capturePreparedBase({ name: `oma-template-${input.handle.runtimeId}` });
      return { provider: base.provider, ref: base.id };
    },

    list: (input) => options.list(input),
  };

  return { name: options.name, lifecycle, vendor: v1Vendor<R>(options.name) };
}
